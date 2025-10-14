import "aframe";
import "aframe-physics-system";

// Dithered fog component with culling
AFRAME.registerComponent("dithered-fog", {
  init: function () {
    const scene = this.el.sceneEl;

    scene.addEventListener("loaded", () => {
      const renderer = scene.renderer;
      const threeScene = scene.object3D;

      // Enable fog - Dark Souls style (darker, denser, closer)
      threeScene.fog = new THREE.Fog(0x6b7a8c, 20, 80);

      // Enable fog on skybox
      const applySkyboxFog = () => {
        const skybox = scene.querySelector("a-sky");
        if (skybox) {
          skybox.object3D.traverse((node) => {
            if (node.material) {
              node.material.fog = true;
              node.material.needsUpdate = true;
            }
          });
        }
      };

      // Apply with delays to catch the skybox after texture loads
      setTimeout(applySkyboxFog, 100);
      setTimeout(applySkyboxFog, 500);
      setTimeout(applySkyboxFog, 1500);

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

    // Track all entities with obj-model (but not skybox or primitives)
    this.cullableEntities = [];
    scene.querySelectorAll("[obj-model]").forEach((el) => {
      // Skip skybox and primitives like spheres
      if (el.tagName === "A-SKY" || el.tagName === "A-SPHERE") return;

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
    // Simplified - just ensure fog is enabled
    if (material.fog === undefined) {
      material.fog = true;
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
      // Player starts at Y=3.77, so trigger immediately
      if (position.y <= 10) {
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
      // Keep WebGL canvas visible for interaction, just hide it visually
      webglCanvas.style.opacity = "0";
      this.sorterCanvas.width = window.innerWidth;
      this.sorterCanvas.height = window.innerHeight;
    } else {
      this.sorterCanvas.style.display = "none";
      webglCanvas.style.opacity = "1";
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
      // Keep WebGL canvas visible for interaction, just hide it visually
      webglCanvas.style.opacity = "0";
      this.setupAsciiCanvas();
    } else {
      this.asciiCanvas.style.display = "none";
      webglCanvas.style.opacity = "1";
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
        this.print("  resetsphere - Reset purple sphere to start");
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

      case "resetsphere": {
        const sphere = document.getElementById("purple-sphere");
        if (sphere && sphere.body) {
          sphere.body.position.set(47.62, 2.63, 53.6);
          sphere.body.velocity.set(0, 0, 0);
          sphere.body.angularVelocity.set(0, 0, 0);
          this.print("Reset purple sphere to starting position");
        } else {
          this.print("Sphere not found or has no physics body");
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

// Dark Souls style bonfire flame shader
AFRAME.registerShader("bonfire-flame", {
  schema: {
    time: { type: "time", is: "uniform" },
  },

  vertexShader: `
    varying vec2 vUv;
    varying vec3 vPosition;

    void main() {
      vUv = uv;
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: `
    uniform float time;
    varying vec2 vUv;
    varying vec3 vPosition;

    // Noise function for fire turbulence
    float noise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    float smoothNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float a = noise(i);
      float b = noise(i + vec2(1.0, 0.0));
      float c = noise(i + vec2(0.0, 1.0));
      float d = noise(i + vec2(1.0, 1.0));

      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.5;
      float frequency = 1.0;

      for(int i = 0; i < 4; i++) {
        value += amplitude * smoothNoise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
      }

      return value;
    }

    void main() {
      vec2 uv = vUv;

      // Make flames rise upward
      uv.y += time * 0.3;

      // Add turbulence
      float turbulence = fbm(uv * 3.0 + time * 0.5);
      uv.x += (turbulence - 0.5) * 0.3;

      // Create flame shape (wider at bottom, narrow at top)
      float flameShape = smoothstep(0.6, 0.0, abs(vUv.x - 0.5) + vUv.y * 0.5);

      // Add noise to flame
      float fireNoise = fbm(uv * 4.0);
      flameShape *= fireNoise;

      // Dark Souls fire colors: intense orange with less yellow
      vec3 deepOrange = vec3(1.0, 0.3, 0.05);
      vec3 brightOrange = vec3(1.3, 0.5, 0.1);
      vec3 hotOrange = vec3(1.5, 0.7, 0.2);
      vec3 whiteTip = vec3(1.6, 1.2, 0.6);

      // Color gradient based on height - mostly orange
      vec3 fireColor;
      if(vUv.y < 0.3) {
        fireColor = mix(deepOrange, brightOrange, vUv.y / 0.3);
      } else if(vUv.y < 0.6) {
        fireColor = mix(brightOrange, hotOrange, (vUv.y - 0.3) / 0.3);
      } else {
        fireColor = mix(hotOrange, whiteTip, (vUv.y - 0.6) / 0.4);
      }

      // Add hot core brightness - more orange
      float coreGlow = smoothstep(0.4, 0.0, abs(vUv.x - 0.5)) * smoothstep(0.8, 0.2, vUv.y);
      fireColor += coreGlow * vec3(0.6, 0.2, 0.05);

      // Add brightness flicker - more intense
      float flicker = 1.0 + 0.3 * sin(time * 4.0 + vUv.y * 10.0);
      fireColor *= flicker;

      // Alpha based on flame shape and height
      float alpha = flameShape * smoothstep(1.0, 0.3, vUv.y);

      gl_FragColor = vec4(fireColor, alpha);
    }
  `,
});

// Billboard component - makes element always face camera
AFRAME.registerComponent("billboard", {
  init: function () {
    this.camera = null;
  },

  tick: function () {
    if (!this.camera) {
      this.camera = document.querySelector("[camera]");
      if (!this.camera) return;
    }

    const cameraPos = this.camera.object3D.position;
    const thisPos = this.el.object3D.position;

    // Calculate direction from this object to camera
    const direction = new THREE.Vector3();
    direction.subVectors(cameraPos, thisPos);

    // Only rotate on Y axis to keep fire upright
    direction.y = 0;
    direction.normalize();

    // Make the plane face the camera
    this.el.object3D.lookAt(cameraPos);
  },
});

// Bonfire embers particle system
AFRAME.registerComponent("bonfire-embers", {
  schema: {
    particleCount: { type: "number", default: 30 },
    spawnRadius: { type: "number", default: 0.3 },
    riseSpeed: { type: "number", default: 0.5 },
    maxHeight: { type: "number", default: 2.5 },
    glowIntensity: { type: "number", default: 1.5 },
  },

  init: function () {
    this.particles = [];
    this.clock = new THREE.Clock();

    // Create particle geometry and material
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const velocities = [];
    const lifetimes = [];
    const sizes = [];
    const colors = [];

    for (let i = 0; i < this.data.particleCount; i++) {
      // Spawn near bonfire base
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * this.data.spawnRadius;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = Math.random() * 0.15;

      positions.push(x, y, z);

      // More varied velocities
      velocities.push(
        (Math.random() - 0.5) * 0.15, // x drift
        this.data.riseSpeed + Math.random() * 0.5, // upward velocity varied
        (Math.random() - 0.5) * 0.15, // z drift
      );

      lifetimes.push(Math.random()); // random starting lifetime
      sizes.push(0.03 + Math.random() * 0.05); // varied sizes

      // Varied ember colors - deep red to bright orange
      const colorVariation = Math.random();
      if (colorVariation < 0.3) {
        colors.push(1.0, 0.2, 0.05); // Deep red-orange
      } else if (colorVariation < 0.7) {
        colors.push(1.0, 0.4, 0.1); // Orange
      } else {
        colors.push(1.0, 0.6, 0.2); // Bright orange
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      "velocity",
      new THREE.Float32BufferAttribute(velocities, 3),
    );
    geometry.setAttribute(
      "lifetime",
      new THREE.Float32BufferAttribute(lifetimes, 1),
    );
    geometry.setAttribute("size", new THREE.Float32BufferAttribute(sizes, 1));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    // Custom shader material for realistic embers
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
      },
      vertexShader: `
        attribute float size;
        attribute float lifetime;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vLifetime;

        void main() {
          vColor = color;
          vLifetime = lifetime;

          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

          // Fade and shrink with lifetime
          float fadeSize = size * (1.0 - lifetime * 0.7);
          gl_PointSize = fadeSize * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vLifetime;

        void main() {
          // Circular particle shape
          vec2 center = gl_PointCoord - vec2(0.5);
          float dist = length(center);

          if (dist > 0.5) discard;

          // Soft edge falloff
          float alpha = smoothstep(0.5, 0.2, dist);

          // Fade out with lifetime
          alpha *= (1.0 - vLifetime);

          // Hot core glow
          float glow = smoothstep(0.5, 0.0, dist);
          vec3 glowColor = vColor + vec3(0.3, 0.2, 0.1) * glow;

          // Flicker brightness
          float flicker = 0.8 + 0.2 * fract(sin(vLifetime * 100.0) * 43758.5);

          gl_FragColor = vec4(glowColor * flicker, alpha * 0.9);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    this.particleSystem = new THREE.Points(geometry, material);
    this.el.object3D.add(this.particleSystem);
  },

  tick: function (time, timeDelta) {
    const delta = timeDelta / 1000;
    const positions = this.particleSystem.geometry.attributes.position;
    const velocities = this.particleSystem.geometry.attributes.velocity;
    const lifetimes = this.particleSystem.geometry.attributes.lifetime;
    const sizes = this.particleSystem.geometry.attributes.size;
    const colors = this.particleSystem.geometry.attributes.color;

    // Update shader time
    this.particleSystem.material.uniforms.time.value = time * 0.001;

    for (let i = 0; i < this.data.particleCount; i++) {
      const i3 = i * 3;

      // Update lifetime
      lifetimes.array[i] += delta * 0.25;

      // Reset particle if it's too old or too high
      if (
        lifetimes.array[i] > 1 ||
        positions.array[i3 + 1] > this.data.maxHeight
      ) {
        // Respawn at base
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * this.data.spawnRadius;
        positions.array[i3] = Math.cos(angle) * radius;
        positions.array[i3 + 1] = Math.random() * 0.15;
        positions.array[i3 + 2] = Math.sin(angle) * radius;

        velocities.array[i3] = (Math.random() - 0.5) * 0.15;
        velocities.array[i3 + 1] = this.data.riseSpeed + Math.random() * 0.5;
        velocities.array[i3 + 2] = (Math.random() - 0.5) * 0.15;

        lifetimes.array[i] = 0;
        sizes.array[i] = 0.03 + Math.random() * 0.05;

        // Randomize color on respawn
        const colorVariation = Math.random();
        if (colorVariation < 0.3) {
          colors.array[i3] = 1.0;
          colors.array[i3 + 1] = 0.2;
          colors.array[i3 + 2] = 0.05;
        } else if (colorVariation < 0.7) {
          colors.array[i3] = 1.0;
          colors.array[i3 + 1] = 0.4;
          colors.array[i3 + 2] = 0.1;
        } else {
          colors.array[i3] = 1.0;
          colors.array[i3 + 1] = 0.6;
          colors.array[i3 + 2] = 0.2;
        }
      } else {
        // Update position based on velocity
        positions.array[i3] += velocities.array[i3] * delta;
        positions.array[i3 + 1] += velocities.array[i3 + 1] * delta;
        positions.array[i3 + 2] += velocities.array[i3 + 2] * delta;

        // Add turbulence - more chaotic
        const turbulence = Math.sin(time * 0.002 + i) * 0.002;
        positions.array[i3] += turbulence;
        positions.array[i3 + 2] += Math.cos(time * 0.002 + i * 1.5) * 0.002;

        // Slow down as they rise (air resistance)
        velocities.array[i3 + 1] *= 0.998;

        // Drift more as they age
        velocities.array[i3] += (Math.random() - 0.5) * 0.001;
        velocities.array[i3 + 2] += (Math.random() - 0.5) * 0.001;
      }
    }

    positions.needsUpdate = true;
    lifetimes.needsUpdate = true;
    sizes.needsUpdate = true;
    colors.needsUpdate = true;
  },

  remove: function () {
    if (this.particleSystem) {
      this.el.object3D.remove(this.particleSystem);
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

// Procedural texture shader for the purple sphere
AFRAME.registerShader("textured-purple", {
  schema: {
    color: { type: "color", default: "#9933FF", is: "uniform" },
    emissive: { type: "color", default: "#9933FF", is: "uniform" },
    emissiveIntensity: { type: "number", default: 1.0, is: "uniform" },
    time: { type: "time", is: "uniform" },
  },

  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;

    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: `
    uniform vec3 color;
    uniform vec3 emissive;
    uniform float emissiveIntensity;
    uniform float time;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;

    // Procedural noise for texture
    float noise(vec3 p) {
      return fract(sin(dot(p, vec3(12.9898, 78.233, 45.5432))) * 43758.5453);
    }

    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for(int i = 0; i < 4; i++) {
        value += amplitude * noise(p);
        p *= 2.0;
        amplitude *= 0.5;
      }
      return value;
    }

    void main() {
      // Create procedural bumpy texture
      vec3 samplePos = vPosition * 4.0;
      float pattern = fbm(samplePos);

      // Add some variation to the color based on the pattern
      vec3 texturedColor = color * (0.7 + pattern * 0.6);

      // Add emissive glow
      vec3 finalColor = texturedColor + emissive * emissiveIntensity;

      // Basic lighting
      vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
      float diffuse = max(dot(vNormal, lightDir), 0.0);
      finalColor *= (0.5 + diffuse * 0.5);

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `,
});

// Click and drag component for physics objects
AFRAME.registerComponent("clickable-physics", {
  schema: {
    force: { type: "number", default: 10 },
  },

  init: function () {
    this.isGrabbed = false;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.targetPosition = new THREE.Vector3();

    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);

    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  },

  onMouseDown: function (event) {
    // Update mouse position
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Get camera
    const camera = document.querySelector("[camera]").getObject3D("camera");

    // Set up raycaster
    this.raycaster.setFromCamera(this.mouse, camera);

    // Check if we hit this object
    const intersects = this.raycaster.intersectObject(this.el.object3D, true);

    if (intersects.length > 0) {
      this.isGrabbed = true;
      console.log("Grabbed sphere!");
    }
  },

  onMouseMove: function (event) {
    if (!this.isGrabbed) return;

    // Update mouse position
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Get camera
    const camera = document.querySelector("[camera]").getObject3D("camera");

    // Set up raycaster
    this.raycaster.setFromCamera(this.mouse, camera);

    // Remember grab distance when first grabbed
    if (!this.grabDistance) {
      this.grabDistance = this.raycaster.ray.origin.distanceTo(
        this.el.object3D.position,
      );
    }

    // Project mouse ray to the grab distance
    this.targetPosition.copy(this.raycaster.ray.direction);
    this.targetPosition.multiplyScalar(this.grabDistance);
    this.targetPosition.add(this.raycaster.ray.origin);
  },

  onMouseUp: function (event) {
    if (this.isGrabbed) {
      console.log("Released sphere!");
    }
    this.isGrabbed = false;
    this.grabDistance = null; // Reset for next grab
  },

  tick: function () {
    if (!this.isGrabbed) return;

    const body = this.el.body;
    if (!body) return;

    // Get current position
    const currentPos = this.el.object3D.position;

    // Calculate force direction
    const force = new THREE.Vector3();
    force.subVectors(this.targetPosition, currentPos);

    // Apply much stronger force for aggressive following
    const strength = this.data.force * 10; // 10x stronger
    body.applyForce(
      new CANNON.Vec3(
        force.x * strength,
        force.y * strength,
        force.z * strength,
      ),
      new CANNON.Vec3(0, 0, 0),
    );

    // Much stronger damping for snappy response
    body.velocity.x *= 0.3;
    body.velocity.y *= 0.3;
    body.velocity.z *= 0.3;
  },

  remove: function () {
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  },
});

// Debug component to check sphere visibility
AFRAME.registerComponent("debug-sphere", {
  init: function () {
    setTimeout(() => {
      const sphere = document.getElementById("purple-sphere");
      console.log("=== SPHERE DEBUG ===");
      console.log("Sphere element:", sphere);
      console.log(
        "Sphere position:",
        sphere ? sphere.object3D.position : "not found",
      );
      console.log(
        "Sphere visible:",
        sphere ? sphere.object3D.visible : "not found",
      );
      console.log(
        "Sphere scale:",
        sphere ? sphere.object3D.scale : "not found",
      );
      console.log("Sphere physics body:", sphere ? sphere.body : "not found");
      console.log("Physics system available:", this.el.sceneEl.systems.physics);
      console.log(
        "CANNON available:",
        typeof CANNON !== "undefined" ? CANNON : "not found",
      );

      const camera = document.querySelector("[camera]");
      if (sphere && camera) {
        const cameraWorldPos = new THREE.Vector3();
        camera.object3D.getWorldPosition(cameraWorldPos);
        const spherePos = sphere.object3D.position;
        const distance = cameraWorldPos.distanceTo(spherePos);
        console.log("Camera world position:", cameraWorldPos);
        console.log("Sphere position:", spherePos);
        console.log("Distance to sphere:", distance);
      }
    }, 2000);
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

  const checkReadyToHide = () => {
    console.log("checkReadyToHide:", { sceneLoaded });
    if (sceneLoaded) {
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

    // Hide loading screen after 1 second
    setTimeout(() => {
      console.log("Hiding loading screen after delay");
      checkReadyToHide();
    }, 1000);
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
