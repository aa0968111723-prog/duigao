import type { StudioKind } from "../../lib/studioEmbed";

export type StudioAlign = "left" | "center" | "right";

type StudioElementBase = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  appearAt: number;
  disappearAt: number;
};

export type StudioTextElement = StudioElementBase & {
  type: "text";
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: StudioAlign;
  italic: boolean;
};

export type StudioShapeElement = StudioElementBase & {
  type: "shape";
  fill: string;
  radius: number;
};

export type StudioImageElement = StudioElementBase & {
  type: "image";
  src: string;
};

export type StudioElement = StudioTextElement | StudioShapeElement | StudioImageElement;

export type StudioDesign = {
  kind: StudioKind;
  name: string;
  width: number;
  height: number;
  background: string;
  duration: number;
  elements: StudioElement[];
};

function nid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blankDesign(kind: StudioKind, name: string, width: number, height: number): StudioDesign {
  const title: StudioTextElement = {
    id: nid("t"),
    name: "標題",
    type: "text",
    x: Math.round(width * 0.1),
    y: Math.round(height * 0.12),
    width: Math.round(width * 0.8),
    height: Math.round(height * 0.12),
    rotation: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    appearAt: 0,
    disappearAt: 0,
    content: kind === "video" ? "活動影片" : "活動海報",
    fontFamily: "Noto Sans TC",
    fontSize: Math.max(28, Math.round(width * 0.07)),
    fontWeight: 700,
    color: kind === "video" ? "#ffffff" : "#1a1c1e",
    align: "center",
    italic: false,
  };
  return {
    kind,
    name: name || (kind === "video" ? "未命名影片" : "未命名海報"),
    width,
    height,
    background: kind === "video" ? "#111318" : "#f4efe6",
    duration: kind === "video" ? 6 : 0,
    elements: [title],
  };
}

export function scaleDesign(design: StudioDesign, width: number, height: number): StudioDesign {
  const sx = design.width ? width / design.width : 1;
  const sy = design.height ? height / design.height : 1;
  return {
    ...design,
    width,
    height,
    elements: design.elements.map((element) => {
      const next = {
        ...element,
        x: element.x * sx,
        y: element.y * sy,
        width: element.width * sx,
        height: element.height * sy,
      };
      if (next.type === "text") {
        return { ...next, fontSize: next.fontSize * sy };
      }
      return next;
    }),
  };
}

export function addTextElement(design: StudioDesign, content = "新文字"): StudioDesign {
  const element: StudioTextElement = {
    id: nid("t"),
    name: content,
    type: "text",
    x: Math.round(design.width * 0.15),
    y: Math.round(design.height * 0.4),
    width: Math.round(design.width * 0.7),
    height: Math.round(design.height * 0.1),
    rotation: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    appearAt: 0,
    disappearAt: 0,
    content,
    fontFamily: "Noto Sans TC",
    fontSize: Math.max(22, Math.round(design.width * 0.045)),
    fontWeight: 600,
    color: design.kind === "video" ? "#ffffff" : "#1a1c1e",
    align: "center",
    italic: false,
  };
  return { ...design, elements: [...design.elements, element] };
}

export function addShapeElement(design: StudioDesign): StudioDesign {
  const element: StudioShapeElement = {
    id: nid("s"),
    name: "色塊",
    type: "shape",
    x: Math.round(design.width * 0.2),
    y: Math.round(design.height * 0.55),
    width: Math.round(design.width * 0.6),
    height: Math.round(design.height * 0.18),
    rotation: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    appearAt: 0,
    disappearAt: 0,
    fill: design.kind === "video" ? "#6157ef" : "#c45c4a",
    radius: 24,
  };
  return { ...design, elements: [...design.elements, element] };
}

export function patchElement(design: StudioDesign, id: string, patch: Partial<StudioElement>): StudioDesign {
  return {
    ...design,
    elements: design.elements.map((element) => (element.id === id ? { ...element, ...patch } as StudioElement : element)),
  };
}

export function drawDesign(ctx: CanvasRenderingContext2D, design: StudioDesign): void {
  ctx.fillStyle = design.background;
  ctx.fillRect(0, 0, design.width, design.height);
  for (const element of design.elements) {
    if (element.hidden) continue;
    ctx.save();
    ctx.globalAlpha = element.opacity;
    ctx.translate(element.x + element.width / 2, element.y + element.height / 2);
    ctx.rotate((element.rotation * Math.PI) / 180);
    ctx.translate(-element.width / 2, -element.height / 2);
    if (element.type === "shape") {
      const r = Math.min(element.radius, element.width / 2, element.height / 2);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(element.width, 0, element.width, element.height, r);
      ctx.arcTo(element.width, element.height, 0, element.height, r);
      ctx.arcTo(0, element.height, 0, 0, r);
      ctx.arcTo(0, 0, element.width, 0, r);
      ctx.closePath();
      ctx.fillStyle = element.fill;
      ctx.fill();
    } else if (element.type === "text") {
      ctx.fillStyle = element.color;
      ctx.font = `${element.italic ? "italic " : ""}${element.fontWeight} ${element.fontSize}px ${element.fontFamily}, sans-serif`;
      ctx.textAlign = element.align;
      ctx.textBaseline = "middle";
      const x = element.align === "left" ? 0 : element.align === "right" ? element.width : element.width / 2;
      ctx.fillText(element.content, x, element.height / 2, element.width);
    }
    ctx.restore();
  }
}
