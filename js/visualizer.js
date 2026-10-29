// Sound-reactive 3D space. Each frequency band drives its own objects:
//   bass   (warm, centre, heavy)  core pulse/swell, shockwaves, camera punch and shake
//   mid    (cool, middle, smooth) panel ring spin and sway, ripple rings, core twist
//   treble (white, outer, sharp)  spectrum needle halo, spark bursts, star twinkle
// Timing (decay lengths, rotation and travel speeds) follows the detected BPM.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
// Vivid keynote palette: orange -> magenta -> violet -> cyan -> lime
vec3 palette(float t){
  t=fract(t);
  vec3 c0=vec3(1.0,0.54,0.0), c1=vec3(1.0,0.18,0.48), c2=vec3(0.55,0.24,1.0), c3=vec3(0.17,0.85,1.0), c4=vec3(0.62,1.0,0.24);
  float s=t*5.0;
  if(s<1.0) return mix(c0,c1,s);
  if(s<2.0) return mix(c1,c2,s-1.0);
  if(s<3.0) return mix(c2,c3,s-2.0);
  if(s<4.0) return mix(c3,c4,s-3.0);
  return mix(c4,c0,s-4.0);
}
`;

const LINE_VS = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const halfLife = (dt, hl) => Math.pow(0.5, dt / hl);

// Quality steps, from best to lightest. The renderer steps down when frames run long.
const QUALITY = [
  { pr: 2, bloom: 0.5 },
  { pr: 1.5, bloom: 0.5 },
  { pr: 1.25, bloom: 0.35 },
  { pr: 1, bloom: 0.35 },
  { pr: 1, bloom: 0 },
];

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.03);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(0, 0.4, 9);

    // Shared uniforms. Bass, mid and treble each get their own level and envelope.
    this.u = {
      uTime: { value: 0 }, uHue: { value: 0 }, uActive: { value: 0 }, uLevel: { value: 0 },
      uBass: { value: 0 }, uKick: { value: 0 },
      uMid: { value: 0 }, uMidEnv: { value: 0 }, uTwist: { value: 0 },
      uTreble: { value: 0 }, uTrebEnv: { value: 0 },
      uPR: { value: 1 },
    };
    this.hue = 0;
    this.env = { kick: 0, kickStr: 0, mid: 0, treb: 0 };
    this.seen = { bass: 0, mid: 0, treble: 0 };
    this.spin = { angle: 0, vel: 0, dir: 1 };
    this.wobble = { x: 0, vx: 0, z: 0, vz: 0 };
    this.cam = { orbit: 0, shake: 0, punch: 0 };
    this.ripple = { age: 9, str: 0 };
    this.panelPeak = [];
    this.needlePeak = [];
    this.pendingWaves = [];
    this.lowPower = false;

    const maxPr = Math.min(window.devicePixelRatio || 1, 2);
    this.qLevel = QUALITY.findIndex((q) => q.pr <= maxPr);
    this.frameMs = 16.7;
    this.slowSince = 0;
    this.fastSince = 0;

    this._sky();
    this._core();
    this._shockwaves();
    this._panels();
    this._ripples();
    this._needles();
    this._sparks();
    this._stars();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.55, 0.35);
    this.composer.addPass(this.bloom);

    this._applyQuality();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------- Background ---------- */
  _sky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.u,
      vertexShader: `varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: NOISE + `
        uniform float uTime,uLevel,uHue,uKick,uActive; varying vec3 vP;
        void main(){
          float n=snoise(vP*1.6+vec3(0.0,uTime*0.04,uTime*0.03));
          float blob=smoothstep(-0.2,0.9,n+0.3*snoise(vP*3.2-vec3(uTime*0.05)));
          vec3 col=palette(uHue+n*0.18+vP.y*0.12);
          float glow=blob*(0.07+uLevel*0.16+uKick*0.05)*(0.45+0.55*uActive);
          float vign=smoothstep(-0.9,0.4,-vP.z+0.2);
          gl_FragColor=vec4(col*glow*vign,1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 20), mat));
  }

  /* ---------- BASS: core (pulse, swell) ---------- */
  _core() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: NOISE + `
        uniform float uTime,uBass,uKick,uTwist,uTreble; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          vec3 p=position;
          // Mid: twist the whole body around its axis (organic deformation).
          float a=p.y*uTwist; float c=cos(a), s=sin(a);
          p.xz=mat2(c,-s,s,c)*p.xz;
          vec3 nrm=normalize(p);
          // Bass: big low-frequency swelling; kicks bulge it outward.
          float d=snoise(nrm*1.3+vec3(uTime*0.3))*(0.12+uBass*0.32+uKick*0.22);
          // Treble: a faint fast shimmer on the surface only.
          d+=snoise(nrm*6.0+vec3(uTime*2.5))*uTreble*0.035;
          p+=nrm*(d+uKick*0.1);
          vD=d;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          vN=normalize(normalMatrix*nrm); vV=normalize(-mv.xyz);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: NOISE + `
        uniform float uHue,uKick,uTime; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          float fr=pow(1.0-max(dot(vN,vV),0.0),2.2);
          vec3 base=palette(uHue+vD*0.6+fr*0.2+uTime*0.01);
          vec3 rim=palette(uHue+0.08+fr*0.15);
          vec3 col=mix(base*0.2,rim*(0.95+uKick*0.6),fr)+base*uKick*0.25;
          gl_FragColor=vec4(col,1.0);
        }`,
    });
    // 28 subdivisions: smooth enough for the swell, far fewer vertices than before for phones.
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 28), mat);
    this.scene.add(this.core);
  }

  /* ---------- BASS: shockwaves from the core on each kick ---------- */
  _shockwaves() {
    this.waves = [];
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uHue: this.u.uHue, uLife: { value: 0 }, uStr: { value: 1 } },
        vertexShader: LINE_VS,
        fragmentShader: NOISE + `
          uniform float uHue,uLife,uStr; varying vec2 vUv;
          void main(){
            float a=(1.0-uLife); a*=a;
            gl_FragColor=vec4(palette(uHue+vUv.x*0.08)*(0.55+uStr*0.5)*a, a);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 96, 1), mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.waves.push({ mesh, mat, life: 1, strength: 1, maxR: 6 });
    }
    this.waveIdx = 0;
  }

  _fireWave(strength, accent) {
    const w = this.waves[this.waveIdx++ % this.waves.length];
    w.life = 0;
    w.strength = strength;
    w.mesh.visible = true;
    // Mostly facing the camera; stronger kicks tilt further and travel further.
    const tilt = 0.25 + strength * 0.5;
    w.mesh.rotation.set((Math.random() - 0.5) * tilt, (Math.random() - 0.5) * tilt, Math.random() * Math.PI);
    w.thick = accent ? 1.6 : 1;
    w.mat.uniforms.uStr.value = strength;
  }

  /* ---------- MID: ring of curved panels (spin, sway, spectrum glow) ---------- */
  _panels() {
    this.panelGroup = new THREE.Group();
    this.scene.add(this.panelGroup);
    this.panels = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const geo = new THREE.CylinderGeometry(4.2, 4.2, 2.6, 16, 1, true, 0, 0.62);
      const mat = new THREE.ShaderMaterial({
        transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { ...this.u, uIdx: { value: i / count }, uAmp: { value: 0 } },
        vertexShader: LINE_VS,
        fragmentShader: NOISE + `
          uniform float uTime,uHue,uIdx,uAmp,uMidEnv; varying vec2 vUv;
          void main(){
            float n=snoise(vec3(vUv*2.2,uTime*0.2+uIdx*10.0));
            vec3 col=palette(uHue+0.5+uIdx*0.25+n*0.1+vUv.y*0.1);
            float edge=smoothstep(0.0,0.06,vUv.x)*smoothstep(1.0,0.94,vUv.x)*smoothstep(0.0,0.06,vUv.y)*smoothstep(1.0,0.94,vUv.y);
            float line=smoothstep(0.014,0.0,abs(vUv.y-0.5-n*0.12*uAmp))*uAmp;
            gl_FragColor=vec4(col*(0.05+uAmp*0.32+uMidEnv*0.08+line),edge*(0.3+uAmp*0.3));
          }`,
      });
      const m = new THREE.Mesh(geo, mat);
      const wrap = new THREE.Group();
      wrap.add(m);
      wrap.rotation.y = (i / count) * Math.PI * 2;
      m.rotation.y = -0.31;
      this.panelGroup.add(wrap);
      this.panels.push({ mesh: m, mat });
    }
  }

  /* ---------- MID: ripple rings around the core (smooth waves, outward ripple on hits) ---------- */
  _ripples() {
    this.rippleRings = [];
    for (let i = 0; i < 3; i++) {
      const R = 2.25 + i * 0.42;
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { ...this.u, uR: { value: R }, uRing: { value: i }, uRipAge: { value: 9 }, uRipStr: { value: 0 } },
        vertexShader: `
          uniform float uTime,uMid,uR,uRing,uRipAge,uRipStr; varying float vGlow;
          void main(){
            float ang=atan(position.y,position.x);
            float w=(length(position.xy)-uR);           // keeps the ribbon's width
            // Sustained mids (vocals, pads): slow travelling waves around the ring.
            float wave=sin(ang*4.0+uTime*1.1+uRing*1.9)*0.16*uMid+sin(ang*7.0-uTime*1.7+uRing)*0.06*uMid;
            // Mid hits: a ripple that runs outward through the rings one after another.
            float front=uRipAge*3.2-uRing*0.45;
            float bump=exp(-front*front*14.0)*uRipStr;
            float r=uR+w+wave+bump*0.35;
            vec3 p=vec3(cos(ang)*r, sin(ang*3.0+uTime*0.8+uRing)*0.1*uMid+bump*0.12, sin(ang)*r);
            vGlow=0.12+uMid*0.45+bump*1.4;
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
          }`,
        fragmentShader: NOISE + `
          uniform float uHue,uRing,uActive; varying float vGlow;
          void main(){ gl_FragColor=vec4(palette(uHue+0.55+uRing*0.06)*vGlow*(0.3+0.7*uActive), 1.0); }`,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(R - 0.018, R + 0.018, 192, 1), mat);
      this.scene.add(mesh);
      this.rippleRings.push({ mesh, mat });
    }
  }

  /* ---------- TREBLE: halo of thin needles drawn from the real treble spectrum ---------- */
  _needles() {
    this.needleCount = 72;
    this.needleR = 1.95;   // just outside the core, so the crown stays on screen in portrait
    const n = this.needleCount;
    this.needlePos = new Float32Array(n * 2 * 3);
    this.needleCol = new Float32Array(n * 2 * 3);
    this.needleJit = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.needlePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.needleCol, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.needles = new THREE.LineSegments(geo, mat);
    this.needles.frustumCulled = false;
    this.scene.add(this.needles);
  }

  /* ---------- TREBLE: spark bursts (GPU-animated particle pool) ---------- */
  _sparks() {
    const N = 360;
    this.sparkN = N;
    this.sparkNext = 0;
    const geo = new THREE.BufferGeometry();
    this.sparkOrigin = new Float32Array(N * 3);
    this.sparkVel = new Float32Array(N * 3);
    this.sparkBirth = new Float32Array(N).fill(-99);
    this.sparkLife = new Float32Array(N).fill(0.4);
    geo.setAttribute('position', new THREE.BufferAttribute(this.sparkOrigin, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.sparkVel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(this.sparkBirth, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: this.u,
      vertexShader: `
        uniform float uTime,uPR; attribute vec3 aVel; attribute float aBirth; attribute float aLife; varying float vA;
        void main(){
          float age=uTime-aBirth; float k=age/aLife;
          if(age<0.0||k>1.0){ gl_Position=vec4(2.0,2.0,2.0,1.0); gl_PointSize=0.0; vA=0.0; return; }
          vec3 p=position+aVel*age*(1.0-0.45*k);       // quick burst, then drag
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          vA=(1.0-k)*(1.0-k);
          gl_PointSize=min((2.0+4.5*(1.0-k))*uPR*(16.0/max(-mv.z,1.0)), 14.0*uPR);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: NOISE + `
        uniform float uHue; varying float vA;
        void main(){
          float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d)*vA;
          gl_FragColor=vec4(mix(vec3(1.0),palette(uHue+0.62),0.25)*a*1.3,a);
        }`,
    });
    this.sparks = new THREE.Points(geo, mat);
    this.sparks.frustumCulled = false;
    this.scene.add(this.sparks);
  }

  _burst(strength, time) {
    const count = Math.round(16 + strength * 40);
    const R = this.needleR;
    const base = Math.random() * Math.PI * 2;
    const spread = 0.6 + Math.random() * 1.6;   // each burst sprays from a different arc
    for (let i = 0; i < count; i++) {
      const j = this.sparkNext++ % this.sparkN;
      const a = base + (Math.random() - 0.5) * spread;
      const ox = Math.cos(a) * R, oy = Math.sin(a) * R;
      this.sparkOrigin.set([ox, oy, (Math.random() - 0.5) * 0.6], j * 3);
      const sp = 3 + Math.random() * 7 * strength;
      this.sparkVel.set([Math.cos(a) * sp + (Math.random() - 0.5) * 2, Math.sin(a) * sp + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3], j * 3);
      this.sparkBirth[j] = time;
      this.sparkLife[j] = 0.22 + Math.random() * 0.33;
    }
    const g = this.sparks.geometry.attributes;
    g.position.needsUpdate = g.aVel.needsUpdate = g.aBirth.needsUpdate = g.aLife.needsUpdate = true;
  }

  /* ---------- TREBLE: star field (twinkle); travel speed follows tempo ---------- */
  _stars() {
    const N = 1600;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 4 + Math.random() * 14;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.sin(a) * r * 0.7;
      pos[i * 3 + 2] = -Math.random() * 80 + 10;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.u, uTravel: { value: 0 } },
      vertexShader: `
        uniform float uTravel,uTreble,uTrebEnv,uPR,uTime; attribute float seed; varying float vSeed; varying float vFade; varying float vTw;
        void main(){
          vec3 p=position; p.z=mod(p.z+uTravel+70.0,80.0)-70.0;
          vSeed=seed; vFade=smoothstep(-70.0,-40.0,p.z)*smoothstep(6.0,1.0,p.z);
          // Treble makes stars flicker fast; quiet treble = steady stars.
          vTw=1.0+uTreble*0.9*sin(uTime*(18.0+seed*30.0)+seed*60.0)+uTrebEnv*step(0.7,seed)*1.5;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          gl_PointSize=min((1.3+seed*2.0)*uPR*(18.0/max(-mv.z,1.0)), 16.0*uPR);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: NOISE + `
        uniform float uHue; varying float vSeed; varying float vFade; varying float vTw;
        void main(){
          float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d)*vFade*max(vTw,0.0);
          gl_FragColor=vec4(mix(vec3(1.0),palette(uHue+vSeed*0.5),0.45)*a,a);
        }`,
    });
    this.stars = new THREE.Points(geo, mat);
    this.starMat = mat;
    this.scene.add(this.stars);
  }

  /* ---------- Quality / power ---------- */
  _applyQuality() {
    const q = QUALITY[this.qLevel];
    this.renderer.setPixelRatio(q.pr);
    this.u.uPR.value = q.pr;
    this.bloom.enabled = q.bloom > 0;
    this.bloomScale = q.bloom || 0.5;
    this.resize();
  }

  // Lighter rendering while the stage is only a blurred backdrop behind other tabs.
  setLowPower(on) { this.lowPower = on; }

  _adaptQuality(frameMs, now) {
    this.frameMs += (frameMs - this.frameMs) * 0.05;
    if (this.frameMs > 24) {                       // below ~42 fps
      this.fastSince = 0;
      if (!this.slowSince) this.slowSince = now;
      if (now - this.slowSince > 1500 && this.qLevel < QUALITY.length - 1) {
        this.qLevel++; this.slowSince = 0; this.frameMs = 16.7; this._applyQuality();
      }
    } else if (this.frameMs < 17.5) {               // comfortably at 60 fps
      this.slowSince = 0;
      if (!this.fastSince) this.fastSince = now;
      const best = QUALITY.findIndex((q) => q.pr <= Math.min(window.devicePixelRatio || 1, 2));
      if (now - this.fastSince > 6000 && this.qLevel > best) {
        this.qLevel--; this.fastSince = 0; this._applyQuality();
      }
    } else { this.slowSince = 0; this.fastSince = 0; }
  }

  resize() {
    if (!this.composer) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * this.bloomScale, h * this.bloomScale);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- Frame ---------- */
  render(t, f, spectrum, nyq = 24000) {
    const now = t;
    const dt = Math.min(0.05, (t - (this._lastT || t)) / 1000) || 0.016;
    const frameMs = t - (this._lastT || t);
    this._lastT = t;
    if (this.lowPower) {
      // Half rate behind other tabs.
      this._skip = !this._skip;
      if (this._skip) return;
    } else if (frameMs > 0) this._adaptQuality(frameMs, now);

    const time = t / 1000;
    const u = this.u;
    const act = f.active ?? 1;
    // Tempo factor: 1 at 120 BPM, faster songs > 1, slower < 1. Unknown tempo = 1.
    const tempo = f.bpm ? clamp(f.bpm / 120, 0.6, 1.5) : 1;
    // Faster songs get shorter, snappier decays; slow songs linger.
    const hlKick = clamp(0.17 / tempo, 0.09, 0.3);

    /* --- one event per detected onset --- */
    if (f.bassHits !== this.seen.bass) {
      this.seen.bass = f.bassHits;
      const s = f.bassStr || 0.6;
      this.env.kick = Math.max(this.env.kick, s);
      this.env.kickStr = s;
      const accent = s > 0.75;
      this._fireWave(s, accent);
      if (accent) this.pendingWaves.push(t + 90);              // strong kick: a second, trailing ring
      this.cam.punch = Math.max(this.cam.punch, s);
      this.cam.shake = Math.max(this.cam.shake, s * 0.16);
      if (accent && f.bassHits % 4 === 0) this.hue += 0.06 + s * 0.08;   // palette steps on strong downbeats
    }
    if (f.midHits !== this.seen.mid) {
      this.seen.mid = f.midHits;
      const s = f.midStr || 0.5;
      this.env.mid = Math.max(this.env.mid, s);
      // Snares/chords kick the panel ring; direction flips every other hit.
      if (f.midHits % 2 === 0) this.spin.dir *= -1;
      this.spin.vel += this.spin.dir * (0.35 + s * 0.9);
      this.wobble.vx += (Math.random() - 0.5) * s * 1.6;
      this.wobble.vz += (Math.random() - 0.5) * s * 1.2;
      this.ripple.age = 0;
      this.ripple.str = s;
    }
    if (f.trebleHits !== this.seen.treble) {
      this.seen.treble = f.trebleHits;
      const s = f.trebleStr || 0.5;
      this.env.treb = Math.max(this.env.treb, s);
      this._burst(s * act, time);
      for (let i = 0; i < this.needleCount; i++) if (Math.random() < 0.35) this.needleJit[i] = Math.random() * s;
    }
    while (this.pendingWaves.length && this.pendingWaves[0] <= t) {
      this.pendingWaves.shift();
      this._fireWave(this.env.kickStr * 0.7, false);
    }

    /* --- envelopes: instant attack, tempo-scaled decay --- */
    this.env.kick *= halfLife(dt, hlKick);
    this.env.mid *= halfLife(dt, hlKick * 1.4);
    this.env.treb *= halfLife(dt, 0.07);

    this.hue += (0.0004 + f.level * 0.001) * dt * 60;
    u.uTime.value = time;
    u.uHue.value = this.hue + f.centroid * 0.4;
    u.uActive.value = act;
    u.uLevel.value = f.level;
    u.uBass.value = f.bass;
    u.uKick.value = this.env.kick;
    u.uMid.value = f.mid;
    u.uMidEnv.value = this.env.mid;
    u.uTreble.value = f.treble;
    u.uTrebEnv.value = this.env.treb;

    /* --- BASS: core --- */
    // Between kicks a soft breath on the beat grid keeps the pulse going.
    const breath = f.bpm ? Math.pow(1 - f.beatPhase, 3) * 0.04 * act : 0;
    this.core.scale.setScalar(0.95 + f.bass * 0.16 + this.env.kick * 0.2 + breath);
    this.core.rotation.y += (0.002 + 0.004 * tempo * act) * dt * 60;
    this.core.rotation.x = Math.sin(time * 0.2) * 0.25;
    u.uTwist.value += ((f.mid * 0.7 + this.env.mid * 0.5) * Math.sin(time * 0.9) - u.uTwist.value) * 0.08;

    /* --- BASS: shockwaves (radius stays inside the camera distance) --- */
    const camDist = this.camera.position.length();
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.life += dt / (0.55 + 0.5 / tempo);     // slower songs: slower, wider rings
      if (w.life >= 1) { w.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - w.life, 3);
      const maxR = camDist * (0.35 + 0.35 * w.strength);
      w.mesh.scale.setScalar(1.3 + e * (maxR - 1.3));
      w.mat.uniforms.uLife.value = w.life;
    }

    /* --- MID: panel ring spin + sway --- */
    this.spin.vel *= halfLife(dt, 0.35);
    const baseSpin = (0.08 + 0.12 * tempo) * act + f.mid * 0.35;
    this.spin.angle += (baseSpin + this.spin.vel) * dt;
    this.panelGroup.rotation.y = this.spin.angle;
    // Spring-damped sway kicked by mid hits.
    for (const [p, v] of [['x', 'vx'], ['z', 'vz']]) {
      this.wobble[v] += (-this.wobble[p] * 14 - this.wobble[v] * 4) * dt;
      this.wobble[p] += this.wobble[v] * dt;
    }
    this.panelGroup.rotation.x = 0.12 + this.wobble.x * 0.5 + Math.sin(time * 0.5 * tempo) * 0.05 * f.mid;
    this.panelGroup.rotation.z = this.wobble.z * 0.4;

    const n = this.panels.length;
    if (spectrum) {
      const bins = spectrum.length;
      const toBin = (hz) => Math.max(1, Math.min(bins - 1, Math.round((hz / nyq) * bins)));
      // Mid band only (250 Hz - 2 kHz), log-spaced across the panels.
      for (let i = 0; i < n; i++) {
        const a = toBin(250 * Math.pow(8, i / n)), b = Math.max(a + 1, toBin(250 * Math.pow(8, (i + 1) / n)));
        let sum = 0;
        for (let k = a; k < b; k++) sum += spectrum[k];
        const raw = sum / ((b - a) * 255);
        this.panelPeak[i] = Math.max(raw, (this.panelPeak[i] || 0.05) * halfLife(dt, 3), 0.04);
        const amp = Math.pow(raw / this.panelPeak[i], 2.2) * act;
        const m = this.panels[i].mat.uniforms.uAmp;
        m.value += (amp - m.value) * (amp > m.value ? 0.5 : 0.12);
      }
    } else {
      for (let i = 0; i < n; i++) this.panels[i].mat.uniforms.uAmp.value = f.mid * (0.6 + 0.4 * Math.sin(time + i));
    }
    for (let i = 0; i < n; i++) {
      const a = this.panels[i].mat.uniforms.uAmp.value;
      this.panels[i].mesh.scale.set(1 + this.env.mid * 0.06, 0.75 + a * 0.55, 1 + this.env.mid * 0.06);
      this.panels[i].mesh.position.y = Math.sin(time * 0.6 * tempo + i) * 0.3 * (0.4 + f.mid);
    }

    /* --- MID: ripple rings --- */
    this.ripple.age += dt;
    for (const r of this.rippleRings) {
      r.mat.uniforms.uRipAge.value = this.ripple.age;
      r.mat.uniforms.uRipStr.value = this.ripple.str * act;
      r.mesh.rotation.x = 0.3 + this.wobble.x * 0.3;   // shader already lays the ring flat
    }

    /* --- TREBLE: needle halo from the real treble spectrum --- */
    const nn = this.needleCount, R = this.needleR;
    const rot = time * 0.15 * tempo;
    const col = new THREE.Color().setHSL(((this.hue + 0.6) % 1 + 1) % 1, 0.4, 0.75);
    for (let i = 0; i < nn; i++) {
      let amp = f.treble * 0.5;
      if (spectrum) {
        const bins = spectrum.length;
        const hz0 = 3000 * Math.pow(14000 / 3000, (i % (nn / 2)) / (nn / 2));   // mirrored halves
        const hz1 = 3000 * Math.pow(14000 / 3000, ((i % (nn / 2)) + 1) / (nn / 2));
        const a = Math.round((hz0 / nyq) * bins), b = Math.max(a + 1, Math.round((hz1 / nyq) * bins));
        let sum = 0;
        for (let k = a; k < b && k < bins; k++) sum += spectrum[k];
        const raw = sum / ((b - a) * 255);
        this.needlePeak[i] = Math.max(raw, (this.needlePeak[i] || 0.05) * halfLife(dt, 2), 0.04);
        amp = Math.pow(raw / this.needlePeak[i], 2.5) * f.treble;
      }
      this.needleJit[i] *= halfLife(dt, 0.05);
      const len = 0.05 + (amp * 1.7 + this.needleJit[i] * 1.1) * act;
      const a = rot + (i / nn) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const o = i * 6;
      this.needlePos[o] = c * R; this.needlePos[o + 1] = s * R; this.needlePos[o + 2] = 0;
      this.needlePos[o + 3] = c * (R + len); this.needlePos[o + 4] = s * (R + len); this.needlePos[o + 5] = 0;
      const bright = 0.35 + amp * 1.6 + this.needleJit[i] * 1.5;
      this.needleCol[o] = col.r * bright; this.needleCol[o + 1] = col.g * bright; this.needleCol[o + 2] = col.b * bright;
      this.needleCol[o + 3] = col.r * 0.2; this.needleCol[o + 4] = col.g * 0.2; this.needleCol[o + 5] = col.b * 0.2;
    }
    this.needles.geometry.attributes.position.needsUpdate = true;
    this.needles.geometry.attributes.color.needsUpdate = true;
    // The halo faces the camera so the needles read as a crown around the core.
    this.needles.quaternion.copy(this.camera.quaternion);
    this.sparks.quaternion.copy(this.camera.quaternion);

    /* --- TREBLE/tempo: stars travel at a tempo-based speed, not with loudness --- */
    this.starMat.uniforms.uTravel.value += (0.4 + 1.6 * tempo * act) * dt * 60 * 0.02;

    /* --- Camera: orbit with tempo; bass punches and shakes --- */
    this.cam.punch *= halfLife(dt, hlKick * 1.2);
    this.cam.shake *= halfLife(dt, hlKick * 0.7);
    this.cam.orbit += (0.05 + 0.12 * tempo * act) * dt;
    const portrait = window.innerWidth < window.innerHeight;
    const baseZ = portrait ? 12 : 9;
    const sh = this.cam.shake;
    this.camera.position.set(
      Math.sin(this.cam.orbit) * 2.0 + (Math.random() - 0.5) * sh,
      0.4 + Math.cos(this.cam.orbit * 0.8) * 0.9 + (Math.random() - 0.5) * sh,
      baseZ - f.bass * 0.6 - this.cam.punch * 0.8,
    );
    // Portrait: aim below the core so it floats in the upper half, clear of the controls.
    this.camera.lookAt(0, portrait ? -2.2 : -0.6, 0);

    this.bloom.strength = Math.min(1.0, 0.35 + this.env.kick * 0.25 + this.env.treb * 0.15 + f.level * 0.2);
    if (this.bloom.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
