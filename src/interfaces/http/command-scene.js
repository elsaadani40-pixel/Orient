(() => {
  'use strict';
  const canvas = document.getElementById('orientScene');
  const status = document.getElementById('sceneRenderer');
  const stage = document.querySelector('.orbit-stage');
  if (!canvas) return;
  function useFallback() {
    if (status) status.textContent = 'CSS FALLBACK';
    canvas.hidden = true;
    if (stage) stage.hidden = false;
  }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' });
  if (!gl) { useFallback(); return; }

  const vertexSource = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uProjection;
    uniform mat4 uModelView;
    uniform vec3 uTint;
    varying vec3 vColor;
    void main() {
      vec3 n = normalize(mat3(uModelView) * aNormal);
      vec3 light = normalize(vec3(-0.45, 0.7, 1.0));
      float diffuse = max(dot(n, light), 0.0);
      float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
      vColor = uTint * (0.24 + diffuse * 0.76) + vec3(0.08, 0.42, 0.55) * rim;
      gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
      gl_PointSize = 4.0;
    }`;
  const fragmentSource = `
    precision mediump float;
    varying vec3 vColor;
    void main() { gl_FragColor = vec4(vColor, 0.96); }`;
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'WebGL shader compilation failed');
    }
    return shader;
  }
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL link failed');
  } catch (_) { useFallback(); return; }
  const loc = {
    position: gl.getAttribLocation(program, 'aPosition'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    modelView: gl.getUniformLocation(program, 'uModelView'),
    tint: gl.getUniformLocation(program, 'uTint')
  };
  function sphere(latitudeBands, longitudeBands) {
    const p = [], n = [], idx = [];
    for (let lat = 0; lat <= latitudeBands; lat++) {
      const theta = lat * Math.PI / latitudeBands;
      for (let lon = 0; lon <= longitudeBands; lon++) {
        const phi = lon * 2 * Math.PI / longitudeBands;
        const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
        p.push(x, y, z); n.push(x, y, z);
      }
    }
    for (let lat = 0; lat < latitudeBands; lat++) for (let lon = 0; lon < longitudeBands; lon++) {
      const first = lat * (longitudeBands + 1) + lon, second = first + longitudeBands + 1;
      idx.push(first, second, first + 1, second, second + 1, first + 1);
    }
    return { p: new Float32Array(p), n: new Float32Array(n), idx: new Uint16Array(idx), count: idx.length };
  }
  function upload(target, data, itemSize) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return { buffer, itemSize, count: data.length / itemSize };
  }
  const mesh = sphere(24, 32);
  const sphereBuffers = {
    p: upload(gl.ARRAY_BUFFER, mesh.p, 3),
    n: upload(gl.ARRAY_BUFFER, mesh.n, 3),
    idx: gl.createBuffer(), count: mesh.count
  };
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereBuffers.idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
  function ring(segments) {
    const points = [];
    for (let i = 0; i < segments; i++) {
      const a = i * Math.PI * 2 / segments;
      points.push(Math.cos(a), 0, Math.sin(a));
    }
    return upload(gl.ARRAY_BUFFER, new Float32Array(points), 3);
  }
  const ringBuffer = ring(144);
  const eventLineBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, eventLineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(6), gl.DYNAMIC_DRAW);
  const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  function multiply(a,b) {
    const o = new Array(16);
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
    return o;
  }
  function translate(x,y,z) { const m=identity();m[12]=x;m[13]=y;m[14]=z;return m; }
  function scale(x,y,z) { const m=identity();m[0]=x;m[5]=y;m[10]=z;return m; }
  function rotateX(a) { const c=Math.cos(a),s=Math.sin(a);return [1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1]; }
  function rotateY(a) { const c=Math.cos(a),s=Math.sin(a);return [c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]; }
  function rotateZ(a) { const c=Math.cos(a),s=Math.sin(a);return [c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1]; }
  function perspective(fovy, aspect, near, far) {
    const f=1/Math.tan(fovy/2), nf=1/(near-far);
    return [f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0];
  }
  function bindMesh(pos, normal) {
    gl.bindBuffer(gl.ARRAY_BUFFER, pos.buffer);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
    if (normal) {
      gl.bindBuffer(gl.ARRAY_BUFFER, normal.buffer);
      gl.enableVertexAttribArray(loc.normal);
      gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(loc.normal);
      gl.vertexAttrib3f(loc.normal, 0, 1, 0);
    }
  }
  function drawSphere(model, tint, projection, count) {
    bindMesh(sphereBuffers.p, sphereBuffers.n);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereBuffers.idx);
    gl.uniformMatrix4fv(loc.projection, false, projection);
    gl.uniformMatrix4fv(loc.modelView, false, new Float32Array(model));
    gl.uniform3fv(loc.tint, tint);
    gl.drawElements(gl.TRIANGLES, count || sphereBuffers.count, gl.UNSIGNED_SHORT, 0);
  }
  function drawRing(model, tint, projection) {
    bindMesh(ringBuffer, null);
    gl.uniformMatrix4fv(loc.projection, false, projection);
    gl.uniformMatrix4fv(loc.modelView, false, new Float32Array(model));
    gl.uniform3fv(loc.tint, tint);
    gl.drawArrays(gl.LINE_LOOP, 0, ringBuffer.count);
  }
  function drawLine(from, to, tint, projection, modelView) {
    gl.bindBuffer(gl.ARRAY_BUFFER, eventLineBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([...from, ...to]));
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(loc.normal);
    gl.vertexAttrib3f(loc.normal, 0, 1, 0);
    gl.uniformMatrix4fv(loc.projection, false, projection);
    gl.uniformMatrix4fv(loc.modelView, false, new Float32Array(modelView));
    gl.uniform3fv(loc.tint, tint);
    gl.drawArrays(gl.LINES, 0, 2);
  }
  let frame = 0, started = performance.now(), lastTime = 0, destroyed = false;
  let activeTint = [0.20, 0.69, 0.93];
  const eventNodes = [];
  function statusTint(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const tokens = normalized.split(/[^a-z0-9_]+/).filter(Boolean);
    if (tokens.some(token => ['failed', 'failure', 'error', 'rejected', 'denied', 'cancelled', 'canceled'].includes(token))) return [0.98, 0.25, 0.39];
    if (tokens.some(token => ['success', 'succeeded', 'complete', 'completed', 'finished', 'done'].includes(token))) return [0.25, 0.88, 0.51];
    if (tokens.some(token => ['approval', 'approvals', 'pending', 'waiting', 'awaiting_approval', 'review', 'queued', 'paused'].includes(token))) return [0.98, 0.72, 0.25];
    if (tokens.some(token => ['running', 'active', 'processing', 'executing', 'started', 'in_progress'].includes(token))) return [0.24, 0.78, 0.98];
    return [0.48, 0.58, 0.76];
  }
  window.ORIENTScene = Object.freeze({
    setExecutionState(value) {
      activeTint = statusTint(String(value || '').slice(0, 64));
    },
    addExecutionEvent(event) {
      if (!event || typeof event !== 'object' || !event.id || !event.type) return;
      const id = String(event.id).slice(0, 200);
      const existing = eventNodes.findIndex(node => node.id === id);
      if (existing >= 0) eventNodes.splice(existing, 1);
      eventNodes.push({ id, type: String(event.type).slice(0, 100), sequence: Number.isFinite(Number(event.sequence)) ? Number(event.sequence) : null });
      if (eventNodes.length > 6) eventNodes.splice(0, eventNodes.length - 6);
    },
    clearExecutionEvents() {
      eventNodes.length = 0;
    },
    getExecutionEventNodeCount() {
      return eventNodes.length;
    }
  });
  function eventTint(type) {
    return statusTint(type);
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width=w; canvas.height=h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  function render(now) {
    if (destroyed || document.hidden) { frame = 0; return; }
    if (reducedMotion.matches && lastTime) { frame = 0; return; }
    if (now - lastTime < 32) { frame = requestAnimationFrame(render); return; }
    lastTime = now;
    resize();
    const t = reducedMotion.matches ? 0 : (now - started) * 0.00028;
    const projection = perspective(0.78, canvas.width / Math.max(1, canvas.height), 0.1, 100);
    gl.clearColor(0.025, 0.045, 0.085, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    const camera = translate(0, 0, -4.25);
    const core = multiply(multiply(camera, rotateY(t)), multiply(rotateX(-0.22), scale(0.78,0.78,0.78)));
    drawSphere(core, activeTint, projection);
    drawRing(multiply(multiply(camera, rotateY(-t*0.65)), rotateZ(0.72)), [0.22,0.91,0.88], projection);
    drawRing(multiply(multiply(camera, rotateY(t*0.42)), rotateX(1.05)), [0.54,0.48,0.98], projection);
    const satellites = [
      {a:t*1.25,r:1.48,y:0.22,c:[0.28,0.95,0.88]},
      {a:-t*0.82+2.1,r:1.76,y:-0.35,c:[0.61,0.55,1.0]},
      {a:t*0.7+4.2,r:1.34,y:-0.62,c:[0.34,0.73,1.0]}
    ];
    satellites.forEach(s => {
      const point = multiply(multiply(multiply(camera, rotateY(t*0.35)), rotateZ(0.72)), multiply(translate(Math.cos(s.a)*s.r,s.y,Math.sin(s.a)*s.r),scale(0.085,0.085,0.085)));
      drawSphere(point,s.c,projection,mesh.count);
    });
    const eventRotation = multiply(rotateY(t*0.35), rotateZ(0.72));
    const eventOrbit = multiply(camera, eventRotation);
    eventNodes.forEach((node, index) => {
      const angle = t * 0.45 + index * (Math.PI * 2 / Math.max(eventNodes.length, 1));
      const radius = 1.18 + (index % 3) * 0.22;
      const height = ((index % 3) - 1) * 0.32;
      const translation = translate(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
      const worldPosition = multiply(eventRotation, translation);
      const endpoint = [worldPosition[12], worldPosition[13], worldPosition[14]];
      drawLine([0, 0, 0], endpoint, [0.14, 0.34, 0.52], projection, camera);
      const point = multiply(eventOrbit, multiply(translation, scale(0.06, 0.06, 0.06)));
      drawSphere(point, eventTint(node.type), projection, mesh.count);
    });
    if (!reducedMotion.matches) frame = requestAnimationFrame(render);
    else frame = 0;
  }
  function start() { if (!destroyed && !document.hidden && !frame) frame=requestAnimationFrame(render); }
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); destroyed=true; if (frame) cancelAnimationFrame(frame); useFallback(); });
  document.addEventListener('visibilitychange', start);
  reducedMotion.addEventListener?.('change', () => { lastTime=0; start(); });
  window.addEventListener('resize', resize, { passive:true });
  if (status) status.textContent = 'WEBGL ACTIVE';
  if (stage) stage.hidden = true;
  start();
})();