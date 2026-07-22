// Renders a line of custom text to a transparent PNG data URL on the client,
// so it can be fed through the same image-texture pipeline as uploaded art.

export type TextDesign = {
  text: string;
  color: string;
  font: string;
};

export const renderTextDesign = ({ text, color, font }: TextDesign) => {
  if (typeof document === "undefined") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const scale = 4; // supersample for crisp edges on the decal
  const fontSize = 80;
  const padding = 24;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return null;
  measure.font = `800 ${fontSize}px ${font}`;
  const width = Math.ceil(measure.measureText(trimmed).width) + padding * 2;
  const height = fontSize + padding * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(scale, scale);
  ctx.font = `800 ${fontSize}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(trimmed, width / 2, height / 2);

  return canvas.toDataURL("image/png");
};
