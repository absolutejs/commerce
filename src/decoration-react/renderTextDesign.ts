// Renders a line of custom text to a transparent PNG data URL on the client,
// so it can be fed through the same image-texture pipeline as uploaded art.

export type TextOutline = {
  /** Outline (stroke) color, drawn under the fill. */
  color: string;
  /** Stroke width as a fraction of the font size (0.02–0.2 is sensible). */
  width: number;
};

export type TextDesign = {
  text: string;
  color: string;
  font: string;
  /** Optional outline drawn around every glyph. */
  outline?: TextOutline | null;
  /** Extra space between letters as a fraction of the font size (-0.1–0.6). */
  letterSpacing?: number;
  /**
   * Bend the line along a circle, in degrees of total sweep (-180–180).
   * Positive arcs upward (a rainbow), negative downward (a smile); 0 = straight.
   */
  arc?: number;
};

const FONT_SIZE = 80;
const PADDING = 24;
const SUPERSAMPLE = 4;
const MAX_ARC = 180;
const MAX_SPACING = 0.6;
const MIN_SPACING = -0.1;
const MAX_OUTLINE = 0.25;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const renderTextDesign = ({
  text,
  color,
  font,
  outline = null,
  letterSpacing = 0,
  arc = 0,
}: TextDesign) => {
  if (typeof document === "undefined") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return null;
  const fontSpec = `800 ${FONT_SIZE}px ${font}`;
  measure.font = fontSpec;

  const spacing = clamp(letterSpacing, MIN_SPACING, MAX_SPACING) * FONT_SIZE;
  const strokeWidth = outline
    ? clamp(outline.width, 0, MAX_OUTLINE) * FONT_SIZE
    : 0;
  const glyphs = Array.from(trimmed).map((char) => ({
    char,
    width: measure.measureText(char).width,
  }));
  const lineWidth = Math.max(
    1,
    glyphs.reduce((sum, glyph) => sum + glyph.width, 0) +
      spacing * Math.max(0, glyphs.length - 1),
  );
  const sweep = (clamp(arc, -MAX_ARC, MAX_ARC) * Math.PI) / MAX_ARC;
  const straight = Math.abs(sweep) < 0.001;
  const pad = PADDING + strokeWidth;
  const half = Math.abs(sweep) / 2;
  // The baseline of a curved line is an arc of length lineWidth.
  const radius = straight ? 0 : lineWidth / Math.abs(sweep);
  const outer = radius + FONT_SIZE / 2;
  const inner = radius - FONT_SIZE / 2;
  const widestGlyph = Math.max(...glyphs.map((glyph) => glyph.width));

  const width = straight
    ? Math.ceil(lineWidth) + pad * 2
    : Math.ceil(
        2 * (half >= Math.PI / 2 ? outer : Math.sin(half) * outer) +
          widestGlyph,
      ) +
      pad * 2;
  const height = straight
    ? FONT_SIZE + pad * 2
    : Math.ceil(Math.max(FONT_SIZE, outer - Math.cos(half) * inner)) + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * SUPERSAMPLE));
  canvas.height = Math.max(1, Math.round(height * SUPERSAMPLE));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.font = fontSpec;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.fillStyle = color;
  if (outline && strokeWidth > 0) {
    ctx.strokeStyle = outline.color;
    // The stroke is centered on the glyph edge and drawn before the fill,
    // so double it to show the full width outside the letter.
    ctx.lineWidth = strokeWidth * 2;
  }
  const paint = (value: string, x: number, y: number) => {
    if (outline && strokeWidth > 0) ctx.strokeText(value, x, y);
    ctx.fillText(value, x, y);
  };

  if (straight && spacing === 0) {
    // One fillText is crisper than per-glyph placement.
    ctx.textAlign = "center";
    paint(trimmed, width / 2, height / 2);

    return canvas.toDataURL("image/png");
  }

  if (straight) {
    ctx.textAlign = "left";
    let cursor = (width - lineWidth) / 2;
    for (const glyph of glyphs) {
      paint(glyph.char, cursor, height / 2);
      cursor += glyph.width + spacing;
    }

    return canvas.toDataURL("image/png");
  }

  // Curved: walk the glyphs along the circle, each turned to its tangent.
  // Rainbow → circle center below the text; smile → above it.
  const upward = sweep > 0;
  const centerX = width / 2;
  const centerY = upward ? pad + outer : height - pad - outer;
  ctx.textAlign = "center";
  let travelled = 0;
  for (const glyph of glyphs) {
    const angle =
      -half + ((travelled + glyph.width / 2) / lineWidth) * Math.abs(sweep);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(upward ? angle : -angle);
    ctx.translate(0, upward ? -radius : radius);
    paint(glyph.char, 0, 0);
    ctx.restore();
    travelled += glyph.width + spacing;
  }

  return canvas.toDataURL("image/png");
};
