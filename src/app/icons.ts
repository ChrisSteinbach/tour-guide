// SVG icon factories. Each returns an <svg> sized to `1em`, so icons
// inherit their size from the host button's font-size and their color
// from `currentColor` — no per-site CSS needed.

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function createSvgRoot(viewBox = "0 0 18 18"): SVGSVGElement {
  return el("svg", {
    width: "1em",
    height: "1em",
    viewBox,
    fill: "currentColor",
    "aria-hidden": "true",
  });
}

export function createPlayIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.appendChild(el("polygon", { points: "4,2 16,9 4,16" }));
  return svg;
}

export function createPauseIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.append(
    el("rect", { x: 3, y: 2, width: 4, height: 14 }),
    el("rect", { x: 11, y: 2, width: 4, height: 14 }),
  );
  return svg;
}

export function createSatelliteIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  const ring = el("circle", {
    cx: 9,
    cy: 9,
    r: 5.5,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.5,
  });
  const tick = (x1: number, y1: number, x2: number, y2: number) =>
    el("line", {
      x1,
      y1,
      x2,
      y2,
      stroke: "currentColor",
      "stroke-width": 1.5,
      "stroke-linecap": "round",
    });
  const dot = el("circle", { cx: 9, cy: 9, r: 1.5 });
  svg.append(
    ring,
    tick(9, 1, 9, 3),
    tick(9, 15, 9, 17),
    tick(1, 9, 3, 9),
    tick(15, 9, 17, 9),
    dot,
  );
  return svg;
}

export function createMapIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.appendChild(
    el("path", {
      d: "M9 1.5C5.4 1.5 2.5 4.4 2.5 8c0 4.8 6.5 8.5 6.5 8.5s6.5-3.7 6.5-8.5c0-3.6-2.9-6.5-6.5-6.5zm0 8.7a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z",
      "fill-rule": "evenodd",
    }),
  );
  return svg;
}

export function createInfoIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.append(
    el("circle", {
      cx: 9,
      cy: 9,
      r: 7,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.5,
    }),
    el("circle", { cx: 9, cy: 5, r: 1 }),
    el("rect", { x: 8.25, y: 7.5, width: 1.5, height: 6, rx: 0.5 }),
  );
  return svg;
}

export function createCloseIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  const stroke = (x1: number, y1: number, x2: number, y2: number) =>
    el("line", {
      x1,
      y1,
      x2,
      y2,
      stroke: "currentColor",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
    });
  svg.append(stroke(4, 4, 14, 14), stroke(14, 4, 4, 14));
  return svg;
}

export function createBackIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.appendChild(el("path", { d: "M3 9L9 3v4h6v4H9v4z" }));
  return svg;
}

export function createFoldedMapIcon(): SVGSVGElement {
  const svg = createSvgRoot("0 0 24 24");
  // Trifold paper map: three panels alternating fold direction,
  // based on Material Design's `map` icon.
  svg.appendChild(
    el("path", {
      d: "M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z",
    }),
  );
  return svg;
}
