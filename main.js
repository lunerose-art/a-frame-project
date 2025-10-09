import "aframe";

// Dithered fog component with culling
AFRAME.registerComponent("dithered-fog", {
  init: function () {
    const scene = this.el.sceneEl;

    scene.addEventListener("loaded", () => {
      const renderer = scene.renderer;
      const threeScene = scene.object3D;

      // Enable fog - Dark Souls style (darker, denser, closer)
      threeScene.fog = new THREE.Fog(0x6b7a8c, 20, 80);

      // Apply partial haze to skybox
      const skybox = scene.querySelector("a-sky");
      if (skybox) {
        skybox.object3D.traverse((node) => {
          if (node.material) {
            // Disable normal fog and add custom haze
            node.material.fog = false;

            // Apply color tint to simulate haze
            const hazeColor = new THREE.Color(0x6b7a8c);
            const hazeStrength = 0.5;

            // Mix the haze color with the material color
            if (node.material.color) {
              node.material.color.lerp(hazeColor, hazeStrength);
            }

            // Reduce opacity slightly for more haze effect
            node.material.opacity = 0.85;
            node.material.transparent = true;
            node.material.needsUpdate = true;
          }
        });
      }

      // Add dither shader to all materials (except those with fog disabled)
      scene.object3D.traverse((node) => {
        if (node.material && node.material.fog !== false) {
          this.addDitherToMaterial(node.material);
        }
      });

      // Start culling system
      this.startCulling();
    });
  },

  startCulling: function () {
    const scene = this.el.sceneEl;
    const fogFar = 80; // Match Dark Souls fog distance
    const cullDistance = fogFar + 20; // Cull objects 20 units beyond fog

    // Create frustum for view culling
    this.frustum = new THREE.Frustum();
    this.cameraMatrix = new THREE.Matrix4();

    // Track all entities with obj-model (but not skybox)
    this.cullableEntities = [];
    scene.querySelectorAll("[obj-model]").forEach((el) => {
      // Skip skybox
      if (el.tagName === "A-SKY") return;

      // Create bounding box for each entity
      const bbox = new THREE.Box3();
      this.cullableEntities.push({
        el: el,
        visible: true,
        bbox: bbox,
      });
    });

    // Check visibility every frame
    this.cullTick = AFRAME.utils.throttle(() => {
      const camera = document.querySelector("[camera]");
      if (!camera) return;

      const cameraPos = camera.object3D.position;
      const threeCamera = camera.getObject3D("camera");

      // Update frustum from camera
      this.cameraMatrix.multiplyMatrices(
        threeCamera.projectionMatrix,
        threeCamera.matrixWorldInverse,
      );
      this.frustum.setFromProjectionMatrix(this.cameraMatrix);

      this.cullableEntities.forEach((item) => {
        const entityPos = item.el.object3D.position;
        const distance = cameraPos.distanceTo(entityPos);

        // Update bounding box
        item.bbox.setFromObject(item.el.object3D);

        // Check if bounding box intersects frustum (more accurate than point check)
        const inView = this.frustum.intersectsBox(item.bbox);

        // Toggle visibility based on distance AND view frustum
        const shouldBeVisible = distance <= cullDistance && inView;

        if (!shouldBeVisible && item.visible) {
          item.el.object3D.visible = false;
          item.visible = false;
        } else if (shouldBeVisible && !item.visible) {
          item.el.object3D.visible = true;
          item.visible = true;
        }
      });
    }, 100); // Throttle to every 100ms for performance
  },

  tick: function () {
    if (this.cullTick) {
      this.cullTick();
    }
  },

  addDitherToMaterial: function (material) {
    if (material.onBeforeCompile && !material.userData.ditherAdded) {
      material.userData.ditherAdded = true;

      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <fog_fragment>",
          `
          #ifdef USE_FOG
            float ditherPattern(vec2 fragCoord) {
              const mat4 ditherTable = mat4(
                0.0, 8.0, 2.0, 10.0,
                12.0, 4.0, 14.0, 6.0,
                3.0, 11.0, 1.0, 9.0,
                15.0, 7.0, 13.0, 5.0
              );
              int x = int(mod(fragCoord.x, 4.0));
              int y = int(mod(fragCoord.y, 4.0));
              return ditherTable[x][y] / 16.0;
            }

            float fogDepth = vFogDepth;
            float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
            float dither = ditherPattern(gl_FragCoord.xy);
            fogFactor = step(dither, fogFactor);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
          #endif
          `,
        );
      };

      material.needsUpdate = true;
    }
  },
});

// Register bright-sky shader
AFRAME.registerShader("bright-sky", {
  schema: {
    src: { type: "map" },
    brightness: { type: "number", default: 2.0 },
  },
  fragmentShader: `
    varying vec2 vUV;
    uniform sampler2D src;
    uniform float brightness;

    void main() {
      vec4 color = texture2D(src, vUV);
      gl_FragColor = vec4(color.rgb * brightness, color.a);
    }
  `,
  vertexShader: `
    varying vec2 vUV;
    void main() {
      vUV = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
});

// Physics-based first-person controller
AFRAME.registerComponent("fps-controller", {
  schema: {
    speed: { type: "number", default: 5 },
    jumpForce: { type: "number", default: 5 },
    crouchHeight: { type: "number", default: 0.8 },
    standHeight: { type: "number", default: 1.6 },
  },

  init: function () {
    this.keys = {};
    this.isCrouching = false;
    this.hasLanded = false;
    this.isPaused = false;
    this.noclip = true; // Noclip mode always enabled

    // Setup raycaster for collision detection
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 0.5; // Check 0.5 units ahead
    this.obstacles = null; // Cache obstacles

    this.onKeyDown = (event) => {
      if (this.isPaused) return;
      this.keys[event.code] = true;

      // Jump (skip in noclip mode)
      if (event.code === "Space" && !this.noclip) {
        const body = this.el.body;
        if (body && this.physicsReady) {
          // Physics-based jump - check if grounded by velocity
          if (Math.abs(body.velocity.y) < 0.5) {
            body.velocity.y = this.data.jumpForce;
          }
        } else {
          // Fallback jump for when physics not ready
          if (!this.velocity) this.velocity = new THREE.Vector3();
          if (Math.abs(this.velocity.y) < 0.1) {
            this.velocity.y = this.data.jumpForce;
          }
        }
      }

      // Toggle crouch
      if (event.code === "KeyC") {
        this.isCrouching = !this.isCrouching;
      }
    };

    this.onKeyUp = (event) => {
      if (this.isPaused) return;
      this.keys[event.code] = false;
    };

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    // Wait for physics body to be ready
    this.physicsReady = false;
    this.el.addEventListener("body-loaded", () => {
      const body = this.el.body;
      if (body) {
        console.log(
          "✓ Player physics body loaded, switching to physics movement",
        );
        // Prevent body from rotating
        body.fixedRotation = true;
        body.updateMassProperties();
        this.physicsReady = true;

        // Clear fallback obstacles cache since we're using physics now
        this.obstacles = null;
      }
    });
  },

  tick: function (time, timeDelta) {
    const el = this.el;

    // Trigger landing event for loading screen
    if (!this.hasLanded) {
      const position = el.object3D.position;
      if (position.y <= 62) {
        this.hasLanded = true;
        this.el.sceneEl.emit("player-landed");
      }
    }

    if (this.isPaused) {
      return;
    }

    const cameraEl = el.querySelector("[camera]");
    const rotation = cameraEl
      ? cameraEl.object3D.rotation
      : el.object3D.rotation;

    const delta = timeDelta / 1000;
    const moveVector = new THREE.Vector3();

    // Movement speed (slower when crouching, faster in noclip)
    let currentSpeed = this.isCrouching
      ? this.data.speed * 0.5
      : this.data.speed;

    // Make noclip faster
    if (this.noclip) {
      currentSpeed = this.data.speed * 3; // 3x speed in noclip
    }

    // Horizontal movement
    if (this.keys.KeyW) {
      moveVector.z -= currentSpeed;
    }
    if (this.keys.KeyS) {
      moveVector.z += currentSpeed;
    }
    if (this.keys.KeyA) {
      moveVector.x -= currentSpeed;
    }
    if (this.keys.KeyD) {
      moveVector.x += currentSpeed;
    }

    // Apply camera rotation to horizontal movement only
    const horizontalMovement = new THREE.Vector3(moveVector.x, 0, moveVector.z);
    horizontalMovement.applyEuler(new THREE.Euler(0, rotation.y, 0));

    // Vertical movement for noclip (applied separately to preserve world-space up/down)
    let verticalMovement = 0;
    if (this.noclip) {
      if (this.keys.Space) {
        verticalMovement = currentSpeed;
      }
      if (this.keys.ShiftLeft || this.keys.ShiftRight) {
        verticalMovement = -currentSpeed;
      }
    }

    if (this.noclip) {
      // Noclip mode - free movement, no collision
      const position = el.object3D.position;
      position.x += horizontalMovement.x * delta;
      position.y += verticalMovement * delta;
      position.z += horizontalMovement.z * delta;
    } else {
      // Manual movement with collision detection
      const position = el.object3D.position;

      // Check for collision before moving
      if (moveVector.length() > 0) {
        // Cache obstacles on first check
        if (!this.obstacles) {
          this.obstacles = [];
          this.el.sceneEl
            .querySelectorAll("[static-body]")
            .forEach((entity) => {
              if (entity.object3D) {
                entity.object3D.traverse((obj) => {
                  if (obj.isMesh) {
                    this.obstacles.push(obj);
                  }
                });
              }
            });
        }

        const moveDir = moveVector.clone().normalize();
        this.raycaster.set(position, moveDir);
        const intersections = this.raycaster.intersectObjects(
          this.obstacles,
          false,
        );

        // Only move if no collision or collision is far enough
        if (intersections.length === 0 || intersections[0].distance > 0.5) {
          position.x += moveVector.x * delta;
          position.z += moveVector.z * delta;
        }
      }

      // Manual gravity
      if (!this.velocity) this.velocity = new THREE.Vector3();
      this.velocity.y -= 20 * delta;

      // Ground check with raycasting
      if (this.obstacles) {
        // Cast ray downward from player position
        const downDir = new THREE.Vector3(0, -1, 0);
        this.raycaster.set(position, downDir);
        this.raycaster.far = 10; // Check up to 10 units below

        const groundIntersections = this.raycaster.intersectObjects(
          this.obstacles,
          false,
        );

        if (groundIntersections.length > 0) {
          const groundY = groundIntersections[0].point.y;
          const playerHeight = 1.6;
          const targetY = groundY + playerHeight;

          const heightDiff = targetY - position.y;

          // Smooth ramp walking - gradually adjust to ground height
          if (Math.abs(heightDiff) < 2.0) {
            // Smoothly interpolate to target height for ramps
            const stepUpSpeed = 10; // Units per second for climbing
            const maxStep = stepUpSpeed * delta;

            if (Math.abs(heightDiff) < maxStep) {
              // Close enough, snap to ground
              position.y = targetY;
              this.velocity.y = 0;
            } else if (heightDiff > 0) {
              // Step up smoothly
              position.y += maxStep;
              this.velocity.y = 0;
            } else {
              // Step down smoothly
              position.y -= maxStep;
              this.velocity.y = 0;
            }
          } else if (heightDiff > 0) {
            // Too high to step up, treat as wall
            position.y += this.velocity.y * delta;
          } else {
            // Falling - apply gravity
            position.y += this.velocity.y * delta;
          }
        } else {
          // No ground detected, apply gravity and check minimum height
          position.y += this.velocity.y * delta;
          if (position.y <= 1.6) {
            position.y = 1.6;
            this.velocity.y = 0;
          }
        }

        // Reset raycaster far distance for horizontal checks
        this.raycaster.far = 0.5;
      } else {
        // Fallback ground check
        if (position.y <= 1.6) {
          position.y = 1.6;
          this.velocity.y = 0;
        } else {
          position.y += this.velocity.y * delta;
        }
      }
    }

    // Smooth camera height transition
    if (cameraEl) {
      const targetHeight = this.isCrouching ? -0.4 : 0;
      const currentCamY = cameraEl.object3D.position.y;
      cameraEl.object3D.position.y += (targetHeight - currentCamY) * delta * 5;
    }
  },

  pause: function () {
    this.isPaused = true;
    // Clear all keys when paused
    this.keys = {};
  },

  play: function () {
    this.isPaused = false;
  },

  remove: function () {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  },
});

// True pixel sorter using canvas overlay
AFRAME.registerComponent("pixel-sorter", {
  schema: {
    enabled: { type: "boolean", default: false },
    threshold: { type: "number", default: 0.3 },
    sortLength: { type: "number", default: 80 },
  },

  init: function () {
    // Create pixel sorter overlay canvas
    this.sorterCanvas = document.createElement("canvas");
    this.sorterCanvas.id = "pixel-sorter-overlay";
    this.sorterCanvas.style.position = "fixed";
    this.sorterCanvas.style.top = "0";
    this.sorterCanvas.style.left = "0";
    this.sorterCanvas.style.width = "100%";
    this.sorterCanvas.style.height = "100%";
    this.sorterCanvas.style.pointerEvents = "none";
    this.sorterCanvas.style.zIndex = "999";
    this.sorterCanvas.style.display = "none";

    this.sorterCtx = this.sorterCanvas.getContext("2d");
    document.body.appendChild(this.sorterCanvas);
  },

  update: function () {
    const webglCanvas = this.el.sceneEl.canvas;

    if (this.data.enabled) {
      this.sorterCanvas.style.display = "block";
      webglCanvas.style.display = "none";
      this.sorterCanvas.width = window.innerWidth;
      this.sorterCanvas.height = window.innerHeight;
    } else {
      this.sorterCanvas.style.display = "none";
      webglCanvas.style.display = "block";
    }
  },

  tick: function () {
    if (!this.data.enabled) return;

    const canvas = this.el.sceneEl.canvas;
    const width = this.sorterCanvas.width;
    const height = this.sorterCanvas.height;

    // Draw the WebGL canvas to our sorter canvas
    this.sorterCtx.drawImage(canvas, 0, 0, width, height);

    // Get image data
    const imageData = this.sorterCtx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Pixel sort each row
    for (let y = 0; y < height; y++) {
      this.sortRow(data, y, width, height);
    }

    // Put the sorted data back
    this.sorterCtx.putImageData(imageData, 0, 0);
  },

  sortRow: function (data, y, width, height) {
    const threshold = this.data.threshold * 255;
    const sortLength = this.data.sortLength;

    let x = 0;
    while (x < width) {
      // Find start of bright region (with alpha check)
      let startX = x;
      while (startX < width) {
        const i = (y * width + startX) * 4;
        const a = data[i + 3];
        // Skip transparent/background pixels
        if (a > 10) {
          const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (brightness > threshold) break;
        }
        startX++;
      }

      if (startX >= width) break;

      // Find end of bright region (or limit by sortLength)
      let endX = startX;
      while (endX < width && endX - startX < sortLength) {
        const i = (y * width + endX) * 4;
        const a = data[i + 3];
        // Stop at transparent/background pixels
        if (a <= 10) break;
        const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (brightness <= threshold) break;
        endX++;
      }

      // Sort this region by brightness
      if (endX > startX) {
        const pixels = [];
        for (let px = startX; px < endX; px++) {
          const i = (y * width + px) * 4;
          pixels.push({
            r: data[i],
            g: data[i + 1],
            b: data[i + 2],
            a: data[i + 3],
            brightness: (data[i] + data[i + 1] + data[i + 2]) / 3,
          });
        }

        // Sort by brightness
        pixels.sort((a, b) => a.brightness - b.brightness);

        // Write sorted pixels back with psychedelic color shift
        const time = Date.now() * 0.001;
        const sortIntensity = (endX - startX) / sortLength; // How much sorting happened

        for (let px = startX; px < endX; px++) {
          const i = (y * width + px) * 4;
          const pixel = pixels[px - startX];

          // Tie hue shift to sort position within the sorted region
          const positionInSort = (px - startX) / (endX - startX);
          const hueShift =
            (positionInSort * sortIntensity * 0.5 + time * 0.2) % 1;

          // Convert RGB to HSL
          const r = pixel.r / 255;
          const g = pixel.g / 255;
          const b = pixel.b / 255;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;

          let h, s;
          if (max === min) {
            h = s = 0;
          } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
          }

          // Apply psychedelic shift
          h = (h + hueShift) % 1;
          s = Math.min(1, s + 0.5);

          // Convert HSL back to RGB
          const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
          };

          let newR, newG, newB;
          if (s === 0) {
            newR = newG = newB = l;
          } else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            newR = hue2rgb(p, q, h + 1 / 3);
            newG = hue2rgb(p, q, h);
            newB = hue2rgb(p, q, h - 1 / 3);
          }

          data[i] = Math.floor(newR * 255);
          data[i + 1] = Math.floor(newG * 255);
          data[i + 2] = Math.floor(newB * 255);
          data[i + 3] = pixel.a;
        }
      }

      x = endX;
    }
  },

  remove: function () {
    if (this.sorterCanvas && this.sorterCanvas.parentNode) {
      this.sorterCanvas.parentNode.removeChild(this.sorterCanvas);
    }
  },
});

// True ASCII effect using canvas 2D overlay
AFRAME.registerComponent("ascii-shader", {
  schema: {
    enabled: { type: "boolean", default: false },
    characters: { type: "string", default: " .:-=+*#%@" },
    fontSize: { type: "number", default: 10 },
  },

  init: function () {
    // Create ASCII overlay canvas
    this.asciiCanvas = document.createElement("canvas");
    this.asciiCanvas.id = "ascii-overlay";
    this.asciiCanvas.style.position = "fixed";
    this.asciiCanvas.style.top = "0";
    this.asciiCanvas.style.left = "0";
    this.asciiCanvas.style.width = "100%";
    this.asciiCanvas.style.height = "100%";
    this.asciiCanvas.style.pointerEvents = "none";
    this.asciiCanvas.style.zIndex = "999";
    this.asciiCanvas.style.display = "none";
    this.asciiCanvas.style.backgroundColor = "black";

    this.asciiCtx = this.asciiCanvas.getContext("2d");
    document.body.appendChild(this.asciiCanvas);

    // Create temporary canvas for sampling
    this.sampleCanvas = document.createElement("canvas");
    this.sampleCtx = this.sampleCanvas.getContext("2d");
  },

  update: function () {
    const webglCanvas = this.el.sceneEl.canvas;

    if (this.data.enabled) {
      this.asciiCanvas.style.display = "block";
      webglCanvas.style.display = "none";
      this.setupAsciiCanvas();
    } else {
      this.asciiCanvas.style.display = "none";
      webglCanvas.style.display = "block";
    }
  },

  setupAsciiCanvas: function () {
    const fontSize = this.data.fontSize;
    const cols = Math.floor(window.innerWidth / (fontSize * 0.6));
    const rows = Math.floor(window.innerHeight / fontSize);

    this.asciiCanvas.width = window.innerWidth;
    this.asciiCanvas.height = window.innerHeight;

    this.sampleCanvas.width = cols;
    this.sampleCanvas.height = rows;

    this.cols = cols;
    this.rows = rows;
  },

  tick: function () {
    if (!this.data.enabled) return;

    const canvas = this.el.sceneEl.canvas;
    const fontSize = this.data.fontSize;
    const chars = this.data.characters;

    // Sample the WebGL canvas for colors
    this.sampleCtx.drawImage(canvas, 0, 0, this.cols, this.rows);
    const imageData = this.sampleCtx.getImageData(0, 0, this.cols, this.rows);

    // Clear ASCII canvas with dark blue background
    this.asciiCtx.fillStyle = "#0a0a1a";
    this.asciiCtx.fillRect(
      0,
      0,
      this.asciiCanvas.width,
      this.asciiCanvas.height,
    );

    // Draw ASCII characters
    this.asciiCtx.font = `${fontSize}px monospace`;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = (y * this.cols + x) * 4;
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];
        const a = imageData.data[i + 3];

        // Calculate brightness
        const brightness = (r + g + b) / 3;
        const charIndex = Math.floor((brightness / 255) * (chars.length - 1));
        const char = chars[charIndex];

        // Add colored tint based on original color
        const avgColor = (r + g + b) / 3;
        const tintR = Math.floor(r * 0.7 + avgColor * 0.3);
        const tintG = Math.floor(g * 0.7 + avgColor * 0.3);
        const tintB = Math.floor(b * 0.7 + avgColor * 0.3);

        // Check if this is foreground (high alpha) or background
        const isForeground = a > 10;

        if (isForeground) {
          // Draw foreground with shadow for depth
          this.asciiCtx.fillStyle = "#000000";
          this.asciiCtx.fillText(
            char,
            x * fontSize * 0.6 + 1,
            y * fontSize + fontSize + 1,
          );
          this.asciiCtx.fillStyle = `rgb(${tintR}, ${tintG}, ${tintB})`;
          this.asciiCtx.fillText(
            char,
            x * fontSize * 0.6,
            y * fontSize + fontSize,
          );
        } else {
          // Draw background with dimmer colors (no shadow)
          const dimR = Math.floor(tintR * 0.4);
          const dimG = Math.floor(tintG * 0.4);
          const dimB = Math.floor(tintB * 0.4);
          this.asciiCtx.fillStyle = `rgb(${dimR}, ${dimG}, ${dimB})`;
          this.asciiCtx.fillText(
            char,
            x * fontSize * 0.6,
            y * fontSize + fontSize,
          );
        }
      }
    }
  },

  remove: function () {
    if (this.asciiCanvas && this.asciiCanvas.parentNode) {
      this.asciiCanvas.parentNode.removeChild(this.asciiCanvas);
    }
  },
});

// In-game console system
AFRAME.registerComponent("game-console", {
  init: function () {
    this.isOpen = false;
    this.consoleHistory = [];
    this.historyIndex = -1;

    // Create console UI
    this.consoleDiv = document.createElement("div");
    this.consoleDiv.id = "game-console";
    this.consoleDiv.style.display = "none";
    this.consoleDiv.innerHTML = `
      <div id="console-output"></div>
      <div id="console-input-line">
        <span>> </span>
        <input type="text" id="console-input" />
      </div>
    `;
    document.body.appendChild(this.consoleDiv);

    this.output = document.getElementById("console-output");
    this.input = document.getElementById("console-input");

    // Bind backtick key to toggle console
    this.onKeyDown = (event) => {
      if (event.key === "`") {
        event.preventDefault();
        this.toggle();
      } else if (this.isOpen) {
        // Handle command history with arrow keys
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (this.historyIndex < this.consoleHistory.length - 1) {
            this.historyIndex++;
            this.input.value =
              this.consoleHistory[
                this.consoleHistory.length - 1 - this.historyIndex
              ];
          }
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          if (this.historyIndex > 0) {
            this.historyIndex--;
            this.input.value =
              this.consoleHistory[
                this.consoleHistory.length - 1 - this.historyIndex
              ];
          } else if (this.historyIndex === 0) {
            this.historyIndex = -1;
            this.input.value = "";
          }
        }
      }
    };

    this.onSubmit = (event) => {
      if (event.key === "Enter" && this.isOpen) {
        const command = this.input.value.trim();
        if (command) {
          this.executeCommand(command);
          this.consoleHistory.push(command);
          this.historyIndex = -1;
        }
        this.input.value = "";
      }
    };

    window.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("keydown", this.onSubmit);

    this.print("Console initialized. Type 'help' for commands.");
  },

  toggle: function () {
    this.isOpen = !this.isOpen;
    this.consoleDiv.style.display = this.isOpen ? "block" : "none";

    const fpsController = document.querySelector("[fps-controller]");
    const camera = document.querySelector("[camera]");

    if (this.isOpen) {
      this.input.focus();
      // Disable player controls
      if (fpsController) {
        fpsController.components["fps-controller"].pause();
      }
      if (camera) {
        camera.setAttribute("look-controls", "enabled", false);
      }
    } else {
      this.input.blur();
      // Re-enable player controls
      if (fpsController) {
        fpsController.components["fps-controller"].play();
      }
      if (camera) {
        camera.setAttribute("look-controls", "enabled", true);
      }
    }
  },

  print: function (text) {
    const line = document.createElement("div");
    line.textContent = text;
    this.output.appendChild(line);
    this.output.scrollTop = this.output.scrollHeight;
  },

  executeCommand: function (command) {
    this.print(`> ${command}`);

    const parts = command.split(" ");
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "help":
        this.print("Available commands:");
        this.print("  help - Show this help");
        this.print("  clear - Clear console");
        this.print("  pos - Show current position");
        this.print("  noclip - Toggle noclip mode (fly freely)");
        this.print("  spawn <model> [x] [y] [z] - Spawn object");
        this.print("  gamemode <edit|play> - Toggle edit mode");
        this.print("  showcollision - Toggle collision boxes");
        this.print("  unstuck - Teleport above map");
        break;

      case "clear":
        this.output.innerHTML = "";
        break;

      case "pos": {
        const player = document.querySelector("[fps-controller]");
        if (player) {
          const pos = player.object3D.position;
          this.print(
            `Position: ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`,
          );
        }
        break;
      }

      case "noclip": {
        const player = document.querySelector("[fps-controller]");
        if (player && player.components["fps-controller"]) {
          const controller = player.components["fps-controller"];
          controller.noclip = !controller.noclip;
          this.print(`Noclip: ${controller.noclip ? "ON" : "OFF"}`);
          if (controller.noclip) {
            this.print("Use Space to fly up, Shift to fly down");
          }
        }
        break;
      }

      case "spawn":
        if (args.length < 1) {
          this.print("Usage: spawn <model> [x] [y] [z]");
          return;
        }

        const modelPath = args[0];
        let x, y, z;

        if (args.length >= 4) {
          x = parseFloat(args[1]);
          y = parseFloat(args[2]);
          z = parseFloat(args[3]);
        } else {
          // Spawn in front of player
          const camera = document.querySelector("[camera]");
          const cameraPos = camera.object3D.position;
          const cameraDir = new THREE.Vector3(0, 0, -1);
          cameraDir.applyQuaternion(camera.object3D.quaternion);
          cameraDir.multiplyScalar(5);

          x = cameraPos.x + cameraDir.x;
          y = cameraPos.y + cameraDir.y;
          z = cameraPos.z + cameraDir.z;
        }

        const entity = document.createElement("a-entity");
        entity.setAttribute("obj-model", `obj: ${modelPath}`);
        entity.setAttribute("position", `${x} ${y} ${z}`);
        this.el.sceneEl.appendChild(entity);

        this.print(
          `Spawned ${modelPath} at ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}`,
        );
        break;

      case "gamemode":
        if (args.length < 1) {
          this.print("Usage: gamemode <edit|play>");
          return;
        }

        const mode = args[0].toLowerCase();
        if (mode === "edit") {
          this.print("Edit mode enabled - not yet implemented");
        } else if (mode === "play") {
          this.print("Play mode enabled");
        } else {
          this.print("Unknown gamemode. Use 'edit' or 'play'");
        }
        break;

      case "showcollision":
        const scene = this.el.sceneEl;
        scene.object3D.traverse((node) => {
          if (node.el && node.el.body) {
            const helper = new THREE.BoxHelper(node, 0x00ff00);
            scene.object3D.add(helper);
          }
        });
        this.print("Collision boxes visualized");
        break;

      case "unstuck": {
        const player = document.querySelector("[fps-controller]");
        if (player) {
          player.object3D.position.set(48.14, 3.77, 57.19);
          this.print("Teleported to spawn point");
        }
        break;
      }

      default:
        this.print(`Unknown command: ${cmd}`);
        this.print("Type 'help' for a list of commands");
    }
  },

  pause: function () {
    // Disable key handling when paused
  },

  play: function () {
    // Re-enable key handling when unpaused
  },

  remove: function () {
    window.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("keydown", this.onSubmit);
    if (this.consoleDiv && this.consoleDiv.parentNode) {
      this.consoleDiv.parentNode.removeChild(this.consoleDiv);
    }
  },
});

// Make materials less glossy/shiny
AFRAME.registerComponent("matte-materials", {
  init: function () {
    const makeMatteRecursive = () => {
      this.el.object3D.traverse((node) => {
        if (node.isMesh && node.material) {
          // High shininess for small, tight specular highlights
          if (node.material.shininess !== undefined) {
            node.material.shininess = 100; // High shininess = smaller highlight (default is 30)
          }

          // If using standard material, reduce metalness and roughness
          if (node.material.metalness !== undefined) {
            node.material.metalness = 0.0;
            node.material.roughness = 0.7; // Moderate roughness for small highlights
          }

          // Keep specular but make it subtle
          if (node.material.specular) {
            node.material.specular.setRGB(0.3, 0.3, 0.3);
          }

          node.material.needsUpdate = true;
        }
      });
    };

    // Apply when any model loads in the scene
    this.el.sceneEl.addEventListener("model-loaded", makeMatteRecursive);

    // Also try after a delay to catch all models
    setTimeout(makeMatteRecursive, 3000);
  },
});

// Debug physics system
AFRAME.registerComponent("physics-debug", {
  init: function () {
    console.log("Physics system:", this.el.systems.physics);

    this.el.addEventListener("body-loaded", (evt) => {
      console.log("Physics body loaded:", evt.target, evt.detail);
    });

    setTimeout(() => {
      const player = document.querySelector("[fps-controller]");
      console.log("=== PLAYER STATUS (2s) ===");
      console.log("Player element:", player);
      console.log("Player body:", player ? player.body : "no player");
      console.log(
        "Player has dynamic-body:",
        player ? player.hasAttribute("dynamic-body") : false,
      );
      console.log(
        "Player components:",
        player ? Object.keys(player.components) : "no player",
      );

      if (player && !player.body) {
        console.warn("⚠️ Physics body not initialized - may need manual init");
      }
    }, 2000);

    setTimeout(() => {
      const player = document.querySelector("[fps-controller]");
      console.log("=== PLAYER STATUS (5s) ===");
      console.log("Player body:", player ? player.body : "no player");
    }, 5000);
  },
});

// Slider control for pixel sorter
document.addEventListener("DOMContentLoaded", () => {
  // Loading screen setup
  const loadingScreen = document.getElementById("loading-screen");
  const loadingProgress = document.getElementById("loading-progress");
  const scene = document.querySelector("a-scene");

  let loadedModels = 0;
  const totalModels = 74; // 73 Firelink + 1 mushroom + bonfire

  // Update progress bar
  const updateProgress = () => {
    const progress = (loadedModels / totalModels) * 100;
    loadingProgress.style.width = progress + "%";
  };

  // Listen for model loads
  scene.addEventListener("model-loaded", () => {
    loadedModels++;
    updateProgress();
  });

  // Track scene loaded state
  let sceneLoaded = false;
  let playerLanded = false;

  const checkReadyToHide = () => {
    console.log("checkReadyToHide:", { sceneLoaded, playerLanded });
    if (sceneLoaded && playerLanded) {
      console.log("Hiding loading screen");
      loadingScreen.classList.add("loaded");
      setTimeout(() => {
        loadingScreen.style.display = "none";
      }, 500); // Wait for fade out animation
    }
  };

  // Wait for scene to load
  scene.addEventListener("loaded", () => {
    console.log("Scene loaded");
    sceneLoaded = true;

    // Add fallback: hide loading screen after 3 seconds regardless
    setTimeout(() => {
      console.log("Fallback: forcing loading screen to hide");
      playerLanded = true;
      checkReadyToHide();
    }, 3000);

    checkReadyToHide();
  });

  // Wait for player to hit the ground
  scene.addEventListener("player-landed", () => {
    console.log("Player landed event received");
    playerLanded = true;
    checkReadyToHide();
  });

  const slider = document.getElementById("pixel-sorter-slider");
  const valueDisplay = document.getElementById("pixel-sorter-value");

  slider.addEventListener("input", (e) => {
    const value = parseInt(e.target.value);

    if (value === 0) {
      // Turn off
      scene.setAttribute("pixel-sorter", "enabled", false);
      valueDisplay.textContent = "OFF";
    } else {
      // Turn on and set threshold
      const threshold = 1 - value / 100; // Invert so higher slider = more effect
      scene.setAttribute("pixel-sorter", {
        enabled: true,
        threshold: threshold,
      });
      valueDisplay.textContent = value;
    }
  });

  // ASCII shader button toggle
  const asciiBtn = document.getElementById("ascii-shader-btn");
  let asciiEnabled = false;

  asciiBtn.addEventListener("click", () => {
    asciiEnabled = !asciiEnabled;
    scene.setAttribute("ascii-shader", "enabled", asciiEnabled);
    asciiBtn.textContent = asciiEnabled
      ? "ASCII Shader: ON"
      : "ASCII Shader: OFF";
    asciiBtn.classList.toggle("active", asciiEnabled);
  });
});
