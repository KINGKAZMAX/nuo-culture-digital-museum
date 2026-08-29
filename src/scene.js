// Three.js 舞台：渲染器、相机、面具点云组（交叉淡切）、星空、灯饰、Bloom
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FilmPass } from "three/addons/postprocessing/FilmPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";
import { makePointsMaterial, loadBPC } from "./pointCloud.js";

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    // 相机: fov=45, 位置(0,0,5), 朝向原点(near .1 far 1000)
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    // 面具根组: 手势旋转作用在这一层
    this.maskRoot = new THREE.Group();
    this.scene.add(this.maskRoot);

    // 背景粒子云(两层实例数据)
    this.bgClouds = [];
    this._bgRoot = new THREE.Group();
    this.scene.add(this._bgRoot);

    // 当前/下一组面具,交叉淡切(1s 淡切)
    this.current = null; // { points, material, def, ghosts[] }
    this.incoming = null;

    this._initStars();
    this._initNebula();
    this._initLanterns();
    this._initComposer();

    this.params = {
      pointSize: 1,
      dispPower: 2,
    };
    this.zoom = 1;

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _initComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    const composer = new EffectComposer(this.renderer);
    // EDL 需要 depth:共享 depthTexture 挂到两个 ping-pong 缓冲(composer clone 会分离)
    this._depthTex = new THREE.DepthTexture(w, h);
    // RenderPass 固定渲染进 readBuffer(renderTarget2);深度纹理只挂 rt2,
    // 否则 EDL 写入 rt1 时会同时读写同一深度附件(GL 未定义行为,读回恒定值)。
    // 注意:交换型 pass(EDL/bloom/film/vignette)须保持偶数个,保证下一帧场景仍渲进 rt2
    composer.renderTarget2.depthTexture = this._depthTex;
    composer.addPass(new RenderPass(this.scene, this.camera));
    // EDL 点云深度着色(potree 算法, BSD-2): 邻域深度对数差暗化,雕纹凹槽出立体感
    this.edl = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this._depthTex },
        uStrength: { value: 0.55 },
        uRadius: { value: 2.0 },
        uNear: { value: this.camera.near },
        uFar: { value: 60 },
        uResolution: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uStrength, uRadius, uNear, uFar;
        uniform vec2 uResolution;
        varying vec2 vUv;
        float linearZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          return (uNear * uFar) / (uFar - d * (uFar - uNear));
        }
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          float zc = linearZ(vUv);
          if (zc > uFar * 0.9) { gl_FragColor = col; return; } // 天空不处理
          vec2 texel = 1.0 / uResolution;
          float shade = 0.0;
          float lc = log(zc);
          const vec4 ox = vec4(-1.0, 1.0, 0.0, 0.0);
          const vec4 oy = vec4(0.0, 0.0, -1.0, 1.0);
          for (int i = 0; i < 4; i++) {
            float zn = linearZ(vUv + vec2(ox[i], oy[i]) * texel * uRadius);
            shade += clamp(exp(-6.0 * abs(lc - log(max(zn, 1e-4)))), 0.0, 1.0);
          }
          shade *= 0.25;
          float f = mix(1.0, shade, uStrength);
          gl_FragColor = vec4(col.rgb * f, col.a);
        }`,
    });
    composer.addPass(this.edl);
    // 轻辉光,threshold 高保色彩
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.55, 0.42);
    composer.addPass(this.bloom);
    // 胶片颗粒(灰度) + 暗角 —— 黑白纪录片质感(three/addons 自带)
    this.film = new FilmPass(0.32, true);
    composer.addPass(this.film);
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.35;
    this.vignette.uniforms.darkness.value = 0.42;
    composer.addPass(this.vignette);
    // linear → sRGB 输出(没有它整帧偏暗)
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this._targetPR ?? Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // 重建共享深度纹理(RT.setSize 不会同步 depthTexture)
    if (this._depthTex) this._depthTex.dispose();
    this._depthTex = new THREE.DepthTexture(w * pr, h * pr);
    this.composer.renderTarget2.depthTexture = this._depthTex;
    if (this.edl) {
      this.edl.uniforms.tDepth.value = this._depthTex;
      this.edl.uniforms.uResolution.value.set(w * pr, h * pr);
    }
    for (const m of [this.current, this.incoming]) {
      if (!m) continue;
      for (const p of [m.points, ...(m.ghosts ?? [])]) {
        p.material.uniforms.uPixelRatio.value = pr;
        p.material.uniforms.uViewH.value = h * pr;
      }
    }
  }

  // ---------- 面具管理 ----------
  _makePoints(geometry, def) {
    // 导出数据已含全部变换(姿态/缩放 baked),用户模型则按 BPC 解析器归一化
    const mat = makePointsMaterial({ pointSize: this.params.pointSize });
    const points = new THREE.Points(geometry, mat);
    const s = def.baseScale ?? 1;
    points.scale.setScalar(s);
    // 反馈光晕层(历史帧累积轨迹)
    const ghosts = [];
    const GHOSTS = [
      { g: 1, alpha: 0.42 },
      { g: 2, alpha: 0.28 },
      { g: 3, alpha: 0.17 },
      { g: 4, alpha: 0.10 },
    ];
    for (const gh of GHOSTS) {
      const gm = makePointsMaterial({ pointSize: this.params.pointSize, ghost: gh.g, opacity: gh.alpha });
      const gp = new THREE.Points(geometry, gm);
      gp.scale.setScalar(s);
      gp.userData.baseOpacity = gh.alpha;
      ghosts.push(gp);
      points.add(gp); // 挂在主层下,跟随旋转
    }
    return points;
  }

  showModel(def, geometry) {
    // 立即切换(无动画),用于首屏/手动选择
    if (this.current) {
      this.maskRoot.remove(this.current.points);
      this.current.points.geometry.dispose();
      this.current.points.material.dispose();
      for (const gp of this.current.ghosts ?? []) gp.material.dispose();
    }
    const points = this._makePoints(geometry, def);
    points.material.uniforms.uOpacity.value = 1;
    for (const gp of points.ghosts ?? []) gp.material.uniforms.uOpacity.value = gp.userData.baseOpacity;
    this.maskRoot.add(points);
    this.current = { points, def, ghosts: points.ghosts ?? [] };
    this.incoming = null;
  }

  // 切换:瞬间硬切 — 旧面具立即移除,新面具立即全量显示,无淡入淡出无重叠
  async transitionTo(loaderFn, defs, index) {
    const def = defs[index];
    if (!def) return;
    if (this.current && this.current.def.key === def.key) return;
    const geometry = await loaderFn(def);
    if (!geometry) return;
    // 等待加载期间目标又变了,放弃
    if (this.current && this.current.def.key === def.key) return;
    // 瞬间替换(与 showModel 同路径)
    this.showModel(def, geometry);
    this._fade = null;
  }

  setDisp(v) {
    const target = v * this.params.dispPower;
    for (const m of [this.current, this.incoming]) {
      if (!m) continue;
      m.points.material.uniforms.uDisp.value = target;
      for (const gp of m.ghosts ?? []) gp.material.uniforms.uDisp.value = target;
    }
    if (this.stars) this.stars.material.uniforms.uKick.value = Math.min(1.5, target * 0.4);
  }

  // ---------- 背景粒子云 ----------
  // manifest.background 由导出工具生成;不存在时静默跳过(保留近似星空)
  async loadBackground(manifest) {
    const bg = manifest?.background;
    if (!bg) return;
    const jobs = [];
    for (const [key, def] of Object.entries(bg)) {
      const url = def.url ?? `./models/${key}.tdp.gz`;
      jobs.push(
        loadBPC(url).then(({ geometry }) => {
          // 原始坐标直接渲染(bg-a 近距蓝紫云与面具同空间, bg-b ±26 环境云)
          const spriteScale = def["transform1.scale"] ?? def["transform3.scale"] ?? 0.005;
          const mat = makePointsMaterial({ pointSize: spriteScale / 0.005, opacity: def.opacity ?? 0.9 });
          const pts = new THREE.Points(geometry, mat);
          this._bgRoot.add(pts);
          this.bgClouds.push(pts);
        }).catch((e) => console.warn(`背景云 ${key} 加载失败`, e))
      );
    }
    await Promise.all(jobs);
  }

  // ---------- 星空背景(星尘): 稀疏暖白金为主,不抢主体 ----------
  _initStars() {
    const N = 700;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const palette = [
      [1.0, 1.0, 1.0],   // 纯白 (80%)
      [1.0, 1.0, 1.0],
      [1.0, 1.0, 1.0],
      [1.0, 1.0, 1.0],
      [0.82, 0.82, 0.82], // 亮灰
      [0.65, 0.65, 0.65], // 中灰
      [0.5, 0.5, 0.5],    // 暗灰
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
          // 黑白配色: 灰阶云气
          vec3 g1 = vec3(0.30, 0.30, 0.31);
          vec3 g2 = vec3(0.10, 0.10, 0.11);
          vec3 g3 = vec3(0.20, 0.19, 0.20);
          float m = fbm(uv * 1.7 - q * 0.8 + 3.7);
          vec3 col = mix(g1, g2, smoothstep(0.35, 0.75, m));
          col = mix(col, g3, smoothstep(0.62, 0.95, m) * 0.55);
          float glow = pow(smoothstep(0.28, 0.85, n), 1.6);
          // 中心暖光晕(衬托面具) + 边缘暗角
          float r = length(uv - vec2(0.5, 0.52));
          float halo = exp(-r * r * 5.5) * 0.5;
          float vig = smoothstep(1.25, 0.35, r);
          vec3 out3 = col * glow * (0.55 + halo) * vig;
          out3 += vec3(0.045, 0.045, 0.048) * halo * vig; // 中性光底
          out3 *= 1.0 + uKick * 0.8; // 握拳爆散时星云呼吸
          out3 *= 0.28; // 背景近黑,星云只做极暗的底纹
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
      mk(0xf0f0f0, 0.05, new THREE.Vector3(-2.2, 1.6, -1.2), 0.22),
      mk(0xc8c8c8, 0.04, new THREE.Vector3(2.4, 0.9, -1.6), 0.16),
      mk(0xffffff, 0.03, new THREE.Vector3(1.9, 2.2, -0.8), 0.3)
    );
    this.scene.add(this.lanterns);
  }

  // ---------- 缩放(滚轮/双指捏合/双手拉距) ----------
  setZoom(z) {
    this.zoom = Math.min(2.6, Math.max(0.45, z));
    this.maskRoot.scale.setScalar(this.zoom);
  }
  getZoom() { return this.zoom ?? 1; }

  // ---------- 每帧 ----------
  update(dt, rot) {
    const t = performance.now() / 1000;
    // 面具旋转: rx/ry 由手势/拖拽驱动, 自动自转叠加在 ry
    this.maskRoot.rotation.order = "ZXY";
    this.maskRoot.rotation.x = rot.rx;
    this.maskRoot.rotation.y = rot.ry;
    this.maskRoot.rotation.z = Math.sin(t * 0.13) * 0.015;

    for (const m of [this.current, this.incoming]) {
      if (!m) continue;
      m.points.material.uniforms.uTime.value = t;
      for (const gp of m.ghosts ?? []) gp.material.uniforms.uTime.value = t;
    }
    // 背景云缓慢漂移
    for (let i = 0; i < this.bgClouds.length; i++) {
      const c = this.bgClouds[i];
      c.rotation.y = t * 0.006 * (i % 2 ? 1 : -1) + i;
      c.material.uniforms.uTime.value = t;
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
