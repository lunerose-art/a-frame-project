import "aframe";

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

// Register vertical movement component
AFRAME.registerComponent("vertical-controls", {
  init: function () {
    this.moveUp = false;
    this.moveDown = false;
    this.speed = 5;

    // Key down handler
    this.onKeyDown = (event) => {
      switch (event.code) {
        case "KeyE":
          this.moveUp = true;
          break;
        case "KeyQ":
          this.moveDown = true;
          break;
      }
    };

    // Key up handler
    this.onKeyUp = (event) => {
      switch (event.code) {
        case "KeyE":
          this.moveUp = false;
          break;
        case "KeyQ":
          this.moveDown = false;
          break;
      }
    };

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  },

  tick: function (time, timeDelta) {
    const position = this.el.object3D.position;
    const delta = (timeDelta / 1000) * this.speed;

    if (this.moveUp) {
      position.y += delta;
    }
    if (this.moveDown) {
      position.y -= delta;
    }
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
      // Find start of bright region
      let startX = x;
      while (startX < width) {
        const i = (y * width + startX) * 4;
        const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (brightness > threshold) break;
        startX++;
      }

      if (startX >= width) break;

      // Find end of bright region (or limit by sortLength)
      let endX = startX;
      while (endX < width && endX - startX < sortLength) {
        const i = (y * width + endX) * 4;
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

// Slider control for pixel sorter
document.addEventListener("DOMContentLoaded", () => {
  const slider = document.getElementById("pixel-sorter-slider");
  const valueDisplay = document.getElementById("pixel-sorter-value");
  const scene = document.querySelector("a-scene");

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
