// Three.js 舞台：渲染器、相机、面具点云组（交叉淡切）、星空、灯饰、Bloom
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { makePointsMaterial } from "./pointCloud.js";

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    // 正向视图: 面具占画面宽 ~55-60%,四周留呼吸空间
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 1.8, 6.4);
    this.camera.lookAt(0, 1.5, 0);

    // 面具根组: 旋转作用在这一层
    this.maskRoot = new THREE.Group();
    this.maskRoot.position.y = 0.1;
    this.scene.add(this.maskRoot);

    // 当前/下一组面具,交叉淡切(交叉淡切)
    this.current = null; // { points, material, def }
    this.incoming = null;

    this._initStars();
    this._initNebula();
    this._initLanterns();
    this._initComposer();

    this.params = {
      pointSize: 1.6,
      dispPower: 2,
    };

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _initComposer() {
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // 克制辉光——只对高亮粒子发光,保住内部色彩层次
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.35, 0.55);
    composer.addPass(this.bloom);
    this.composer = composer;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const prU = Math.min(window.devicePixelRatio, 2);
    for (const m of [this.current, this.incoming]) {
      if (m) m.points.material.uniforms.uPixelRatio.value = prU;
    }
  }

  // ---------- 面具管理 ----------
  _makePoints(geometry, def) {
    const mat = makePointsMaterial({ pointSize: this.params.pointSize });
    const points = new THREE.Points(geometry, mat);
    const s = def.baseScale ?? 2.6;
    points.scale.setScalar(s);
    points.rotation.x = THREE.MathUtils.degToRad(def.baseTilt ?? 0);
    return points;
  }

  showModel(def, geometry) {
    // 立即切换(无动画),用于首屏/手动选择
    if (this.current) {
      this.maskRoot.remove(this.current.points);
      this.current.points.geometry.dispose();
      this.current.points.material.dispose();
    }
    const points = this._makePoints(geometry, def);
    points.material.uniforms.uOpacity.value = 1;
    this.maskRoot.add(points);
    this.current = { points, def };
    this.incoming = null;
  }

  // 捏合切换:交叉淡切到 index 指定的模型(1s 交叉淡切)
  async transitionTo(loaderFn, defs, index, duration = 1000) {
    const def = defs[index];
    if (!def) return;
    if (this.current && this.current.def.key === def.key) return;
    // 上一次淡切还没结束:先把 incoming 提升为 current(跳到终态)
    if (this._fade && this.incoming) {
      if (this.current) {
        this.maskRoot.remove(this.current.points);
        this.current.points.geometry.dispose();
        this.current.points.material.dispose();
      }
      this.current = this.incoming;
      this.current.points.material.uniforms.uOpacity.value = 1;
      this.incoming = null;
      this._fade = null;
    }
    const geometry = await loaderFn(def);
    if (!geometry) return;
    // 等待加载期间目标又变了,放弃
    if (this.current && this.current.def.key === def.key) return;

    if (this.incoming) {
      this.maskRoot.remove(this.incoming.points);
      this.incoming.points.geometry.dispose();
      this.incoming.points.material.dispose();
      this.incoming = null;
    }
    const points = this._makePoints(geometry, def);
    points.material.uniforms.uOpacity.value = 0;
    this.maskRoot.add(points);
    this.incoming = { points, def };
    this._fade = { t0: performance.now(), duration };
  }

  setDisp(v) {
    const target = v * this.params.dispPower;
    for (const m of [this.current, this.incoming]) {
      if (m) m.points.material.uniforms.uDisp.value = target;
    }
    if (this.stars) this.stars.material.uniforms.uKick.value = Math.min(1.5, target * 0.4);
  }

  // ---------- 星空背景(星尘): 稀疏暖白金为主,不抢主体 ----------
  _initStars() {
    const N = 700;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const palette = [
      [1.0, 0.92, 0.75], // 暖白金 (80%)
      [1.0, 0.92, 0.75],
      [1.0, 0.92, 0.75],
      [1.0, 0.92, 0.75],
      [1.0, 0.84, 0.5],  // 金
      [0.9, 0.55, 0.45], // 微红
      [0.6, 0.72, 0.95], // 微蓝
    ];
    for (let i = 0; i < N; i++) {
      const r = 7 + Math.random() * 16;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3 + 0] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.7 + 1;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const c = palette[(Math.random() * palette.length) | 0];
      const b = 0.2 + Math.random() * 0.4;
      col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uKick: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uPixelRatio; uniform float uKick;
        attribute float seed; attribute vec3 color;
        varying vec3 vColor; varying float vTw;
        void main() {
          vColor = color;
          vec3 p = position;
          p.y += sin(uTime * 0.05 + seed * 30.0) * 0.35;
          p.x += cos(uTime * 0.04 + seed * 50.0) * 0.3;
          float tw = sin(uTime * (0.6 + seed * 2.2) + seed * 400.0);
          vTw = 0.35 + 0.4 * tw + uKick * (0.5 + 0.5 * tw);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.8 + 1.2 * seed) * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vTw;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d) * vTw;
          gl_FragColor = vec4(vColor * vTw, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geo, mat);
    this.scene.add(this.stars);
  }

  // ---------- 星云光影背景(噪声渐变的动态云气) ----------
  _initNebula() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uKick: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          // 全屏铺底,永远在最远处
          gl_Position = vec4(position.xy, 0.99999, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime; uniform float uKick;
        varying vec2 vUv;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 17.3; a *= 0.5; }
          return v;
        }
        void main() {
          vec2 uv = vUv;
          float t = uTime * 0.018;
          // 域扭曲:云气丝缕感
          vec2 q = vec2(fbm(uv * 2.6 + t), fbm(uv * 2.6 - t * 0.7 + 5.2));
          float n = fbm(uv * 3.2 + q * 1.4 + vec2(t * 0.5, -t * 0.3));
          // 双色云:暗金主调 + 少量青/紫
          vec3 gold = vec3(0.32, 0.24, 0.11);
          vec3 teal = vec3(0.07, 0.14, 0.17);
          vec3 violet = vec3(0.14, 0.08, 0.16);
          float m = fbm(uv * 1.7 - q * 0.8 + 3.7);
          vec3 col = mix(gold, teal, smoothstep(0.35, 0.75, m));
          col = mix(col, violet, smoothstep(0.62, 0.95, m) * 0.55);
          float glow = pow(smoothstep(0.28, 0.85, n), 1.6);
          // 中心暖光晕(衬托面具) + 边缘暗角
          float r = length(uv - vec2(0.5, 0.52));
          float halo = exp(-r * r * 5.5) * 0.5;
          float vig = smoothstep(1.25, 0.35, r);
          vec3 out3 = col * glow * (0.55 + halo) * vig;
          out3 += vec3(0.05, 0.038, 0.02) * halo * vig; // 纯暖光底
          out3 *= 1.0 + uKick * 0.8; // 握拳爆散时星云呼吸
          gl_FragColor = vec4(out3, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    quad.renderOrder = -10;
    this.nebula = quad;
    this.scene.add(quad);
  }

  // ---------- 灯饰(发光小构件漂浮) ----------
  _initLanterns() {
    this.lanterns = new THREE.Group();
    const mk = (color, size, pos, speed) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color });
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size * 1.5, size), mat);
      const s2 = new THREE.Mesh(
        new THREE.SphereGeometry(size * 0.7, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff2cc })
      );
      s2.position.y = size * 1.4;
      g.add(box, s2);
      g.position.copy(pos);
      g.userData.speed = speed;
      return g;
    };
    this.lanterns.add(
      mk(0xf5d489, 0.05, new THREE.Vector3(-2.2, 1.6, -1.2), 0.22),
      mk(0xe8b45a, 0.04, new THREE.Vector3(2.4, 0.9, -1.6), 0.16),
      mk(0xfff0c2, 0.03, new THREE.Vector3(1.9, 2.2, -0.8), 0.3)
    );
    this.scene.add(this.lanterns);
  }

  // ---------- 每帧 ----------
  update(dt, rot) {
    const t = performance.now() / 1000;
    // 面具旋转: rx/ry 由手势驱动, 自动自转叠加在 ry
    this.maskRoot.rotation.order = "ZXY";
    this.maskRoot.rotation.x = rot.rx;
    this.maskRoot.rotation.y = rot.ry;
    this.maskRoot.rotation.z = Math.sin(t * 0.13) * 0.015;

    for (const m of [this.current, this.incoming]) {
      if (!m) continue;
      m.points.material.uniforms.uTime.value = t;
    }
    if (this._fade && this.incoming) {
      const k = Math.min(1, (performance.now() - this._fade.t0) / this._fade.duration);
      const e = k * k * (3 - 2 * k);
      this.incoming.points.material.uniforms.uOpacity.value = e;
      if (this.current) {
        this.current.points.material.uniforms.uOpacity.value = 1 - e;
        // 淡切时位置也轻微插值(缩放差异)
      }
      if (k >= 1) {
        if (this.current) {
          this.maskRoot.remove(this.current.points);
          this.current.points.geometry.dispose();
          this.current.points.material.dispose();
        }
        this.current = this.incoming;
        this.incoming = null;
        this._fade = null;
      }
    }
    // 星云 & 星空 & 灯饰
    this.nebula.material.uniforms.uTime.value = t;
    this.nebula.material.uniforms.uKick.value = Math.min(1, (this.stars.material.uniforms.uKick.value || 0));
    this.stars.material.uniforms.uTime.value = t;
    this.stars.rotation.y = t * 0.004;
    for (const l of this.lanterns.children) {
      l.position.y += Math.sin(t * l.userData.speed) * 0.0006;
      l.rotation.y = t * l.userData.speed * 0.5;
      l.rotation.x = Math.sin(t * l.userData.speed * 0.7) * 0.3;
    }
    this.composer.render();
  }
}
