// Sound-reactive 3D space: flowing gradient sky, deforming iridescent core,
// orbiting curved glass panels, and a particle tunnel.
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

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.035);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(0, 0.4, 9);

    this.u = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uLevel: { value: 0 },
      uHue: { value: 0 },
      uBeat: { value: 0 },
    };
    this.hue = 0;
    this.shake = 0;
    this.spinVel = 0;       // ring angular velocity, kicked by beats
    this.spinAngle = 0;
    this.orbit = 0;         // camera orbit angle, faster when loud
    this.punch = 0;         // camera dolly on kicks
    this.flash = 0;         // snare flash
    this.lastBeatCount = 0;
    this.panelPeak = [];

    this._sky();
    this._core();
    this._panels();
    this._particles();
    this._shockwaves();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.6, 0.32);
    this.composer.addPass(this.bloom);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _sky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.u,
      vertexShader: `varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: NOISE + `
        uniform float uTime,uBass,uMid,uLevel,uHue,uBeat; varying vec3 vP;
        void main(){
          float n=snoise(vP*1.6+vec3(0.0,uTime*0.04,uTime*0.03));
          float n2=snoise(vP*3.2-vec3(uTime*0.05));
          float blob=smoothstep(-0.2,0.9,n+0.35*n2+uMid*0.6);
          vec3 col=palette(uHue+n*0.18+vP.y*0.12);
          float glow=blob*(0.1+uLevel*0.26+uBeat*0.08);
          float vign=smoothstep(-0.9,0.4,vP.z*-1.0+0.2);
          gl_FragColor=vec4(col*glow*vign,1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 32), mat);
    this.scene.add(this.sky);
  }

  _core() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: NOISE + `
        uniform float uTime,uBass,uMid,uTreble,uBeat; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          vec3 p=position;
          float d=snoise(normal*1.4+vec3(uTime*0.35))*(0.16+uBass*0.5)
                 +snoise(normal*4.0+vec3(uTime*0.8))*(0.03+uTreble*0.25);
          p+=normal*(d+uBeat*0.12);
          vD=d;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: NOISE + `
        uniform float uHue,uLevel,uTime; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          float fr=pow(1.0-max(dot(vN,vV),0.0),2.2);
          vec3 base=palette(uHue+vD*0.8+fr*0.35+uTime*0.01);
          vec3 rim=palette(uHue+0.45+fr*0.2);
          vec3 col=mix(base*0.22,rim*1.0,fr)+base*uLevel*0.22;
          gl_FragColor=vec4(col,1.0);
        }`,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 48), mat);
    this.scene.add(this.core);
  }

  _panels() {
    this.panelGroup = new THREE.Group();
    this.scene.add(this.panelGroup);
    this.panels = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      // A slice of an open cylinder = a curved card, like the reference carousels.
      const geo = new THREE.CylinderGeometry(4.2, 4.2, 2.6, 24, 1, true, 0, 0.62);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { ...this.u, uIdx: { value: i / count }, uAmp: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
        fragmentShader: NOISE + `
          uniform float uTime,uHue,uIdx,uAmp,uBeat; varying vec2 vUv;
          void main(){
            vec2 uv=vUv;
            float n=snoise(vec3(uv*2.2,uTime*0.2+uIdx*10.0));
            vec3 col=palette(uHue+uIdx*0.6+n*0.15+uv.y*0.15);
            float edge=smoothstep(0.0,0.06,uv.x)*smoothstep(1.0,0.94,uv.x)*smoothstep(0.0,0.06,uv.y)*smoothstep(1.0,0.94,uv.y);
            float glow=0.05+uAmp*0.3+uBeat*0.05;
            float line=smoothstep(0.012,0.0,abs(uv.y-0.5-n*0.1*uAmp))*uAmp*1.0;
            gl_FragColor=vec4(col*(glow+line),edge*(0.32+uAmp*0.28));
          }`,
      });
      const m = new THREE.Mesh(geo, mat);
      const wrap = new THREE.Group();
      wrap.add(m);
      wrap.rotation.y = (i / count) * Math.PI * 2;
      m.rotation.y = -0.31; // center the slice on its anchor angle
      this.panelGroup.add(wrap);
      this.panels.push({ wrap, mesh: m, mat });
    }
    this.panelGroup.rotation.x = 0.12;
  }

  // Expanding rings fired from the core on every kick.
  _shockwaves() {
    this.waves = [];
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uHue: this.u.uHue, uLife: { value: 0 }, uShift: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
        fragmentShader: NOISE + `
          uniform float uHue,uLife,uShift; varying vec2 vUv;
          void main(){
            float a=(1.0-uLife); a*=a;
            gl_FragColor=vec4(palette(uHue+uShift+vUv.x*0.3)*0.9*a, a);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.96, 1.0, 96, 1), mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.waves.push({ mesh, mat, life: 1, tiltX: 0, tiltY: 0 });
    }
    this.waveIdx = 0;
  }

  _fireWave(strength) {
    const w = this.waves[this.waveIdx++ % this.waves.length];
    w.life = 0;
    w.strength = strength;
    w.mesh.visible = true;
    // Random tilt so rings cut through space at different angles.
    w.mesh.rotation.set((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, Math.random() * Math.PI);
    w.mat.uniforms.uShift.value = Math.random() * 0.5;
  }

  _particles() {
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 3 + Math.random() * 14;
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
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...this.u, uTravel: { value: 0 }, uPR: { value: this.renderer.getPixelRatio() } },
      vertexShader: `
        uniform float uTravel,uTreble,uPR; attribute float seed; varying float vSeed; varying float vFade;
        void main(){
          vec3 p=position; p.z=mod(p.z+uTravel+70.0,80.0)-70.0;
          vSeed=seed; vFade=smoothstep(-70.0,-40.0,p.z)*smoothstep(6.0,1.0,p.z);
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          // Capped so specks flying past the lens never flood the screen.
          gl_PointSize=min((1.5+seed*2.5+uTreble*3.0)*uPR*(18.0/max(-mv.z,1.0)), 28.0*uPR);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: NOISE + `
        uniform float uHue; varying float vSeed; varying float vFade;
        void main(){
          float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d);
          gl_FragColor=vec4(mix(vec3(1.0),palette(uHue+vSeed*0.5),0.6)*a*vFade,a*vFade);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.particleMat = mat;
    this.scene.add(this.points);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    // Pull back on portrait screens so the ring stays in frame.
    this.camera.position.z = w < h ? 12 : 9;
    this.camera.updateProjectionMatrix();
  }

  render(t, f, spectrum) {
    const time = t / 1000;
    const dt = Math.min(0.05, (t - (this._lastT || t)) / 1000) || 0.016;
    this._lastT = t;
    const k60 = dt * 60;   // frame-rate independent decay
    const u = this.u;
    u.uTime.value = time;
    u.uBass.value = f.bass;
    u.uMid.value = f.mid;
    u.uTreble.value = f.treble;
    u.uLevel.value = f.level;
    u.uBeat.value = f.beat;

    // New kick: fire a shockwave, kick the ring's spin, punch the camera.
    if (f.beatCount !== this.lastBeatCount) {
      this.lastBeatCount = f.beatCount;
      this._fireWave(0.6 + f.bass * 0.6);
      this.spinVel += (0.035 + f.bass * 0.05) * (f.beatCount % 8 < 4 ? 1 : -1);
      this.punch = 1;
      // Every 4th kick the palette jumps.
      if (f.beatCount % 4 === 0) this.hue += 0.12;
    }
    this.punch *= Math.pow(0.88, k60);
    this.flash = Math.max(this.flash * Math.pow(0.8, k60), f.snare);

    this.hue += (0.0006 + f.level * 0.002) * k60;
    u.uHue.value = this.hue + f.centroid * 0.5;

    // Core: bigger breathing, twist with mids.
    this.core.rotation.y += (0.004 + f.mid * 0.03) * k60;
    this.core.rotation.x = Math.sin(time * 0.2) * 0.3 + f.treble * 0.3;
    this.core.rotation.z = Math.sin(time * 0.13) * 0.2 + this.spinVel * 3;
    const s = 0.95 + f.bass * 0.28 + f.beat * 0.14;
    this.core.scale.setScalar(s);

    // Ring of panels: spin with momentum, flare outward on hits.
    this.spinVel *= Math.pow(0.95, k60);
    this.spinAngle += (0.0015 + f.mid * 0.006 + this.spinVel) * k60;
    this.panelGroup.rotation.y = this.spinAngle;
    this.panelGroup.rotation.x = 0.12 + Math.sin(time * 0.3) * 0.15 + f.mid * 0.2;
    this.panelGroup.rotation.z = Math.sin(time * 0.21) * 0.12 + this.spinVel * 1.5;
    const n = this.panels.length;
    this.panels.forEach((p, i) => {
      let amp = f.mid;
      if (spectrum) {
        const bins = Math.floor(spectrum.length * 0.45);
        // Log-spaced bands so every panel gets a lively slice of the spectrum.
        const a = Math.floor(Math.pow(i / n, 1.8) * bins) + 1;
        const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 1.8) * bins) + 1);
        let sum = 0;
        for (let k = a; k < b; k++) sum += spectrum[k];
        const raw = sum / ((b - a) * 255);
        this.panelPeak[i] = Math.max(raw, (this.panelPeak[i] || 0.05) * 0.996, 0.03);
        amp = Math.min(1, Math.pow(raw / this.panelPeak[i], 1.6) * Math.min(1, raw / 0.015));
      }
      const cur = p.mat.uniforms.uAmp.value;
      p.mat.uniforms.uAmp.value = cur + (amp - cur) * (amp > cur ? 0.6 : 0.15);
      const a = p.mat.uniforms.uAmp.value;
      // Kept under ~1.4x so a flaring panel never sweeps through the camera.
      const r = 1 + f.bass * 0.15 + a * 0.12 + f.beat * 0.1;
      p.mesh.scale.set(r, 0.75 + a * 0.6, r);
      p.mesh.position.y = Math.sin(time * 0.6 + i) * 0.35 + (a - 0.3) * 0.6 * Math.sin(i * 2.1);
    });

    // Shockwaves expand and fade.
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.life += dt / 1.1;
      if (w.life >= 1) { w.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - w.life, 3);
      // Stop short of the camera so a ring never passes through the lens.
      const maxR = this.camera.position.length() * 0.72;
      w.mesh.scale.setScalar(1.4 + e * (maxR - 1.4) * Math.min(1, w.strength));
      w.mat.uniforms.uLife.value = w.life;
    }

    // Particles rush past on loud passages and lurch on kicks.
    this.particleMat.uniforms.uTravel.value += (0.03 + f.level * 1.4 + f.beat * 1.2) * k60;
    this.points.rotation.z += (0.0005 + f.mid * 0.004 + this.spinVel * 0.5) * k60;

    // Camera: orbit speeds up with energy, dollies in on kicks, sways with mids.
    this.orbit += (0.0015 + f.level * 0.008) * k60;
    this.shake = Math.max(this.shake * Math.pow(0.85, k60), f.beat * 0.18);
    const portrait = window.innerWidth < window.innerHeight;
    const baseZ = portrait ? 12 : 9;
    this.camera.position.x = Math.sin(this.orbit) * 2.2 + (Math.random() - 0.5) * this.shake;
    this.camera.position.y = 0.4 + Math.cos(this.orbit * 0.8) * 1.0 + (Math.random() - 0.5) * this.shake;
    this.camera.position.z = baseZ - f.bass * 0.8 - this.punch * 0.9;
    // Portrait: aim below the core so it floats in the upper half, clear of the controls.
    this.camera.lookAt(0, portrait ? -2.2 : -0.6, 0);
    this.camera.rotation.z += Math.sin(time * 0.5) * 0.03 * (0.3 + f.mid);

    this.bloom.strength = Math.min(1.05, 0.4 + f.level * 0.4 + f.beat * 0.2 + this.flash * 0.2);
    this.renderer.toneMappingExposure = 1.0 + Math.min(0.1, this.flash * 0.08 + f.beat * 0.04);
    this.composer.render();
  }
}
