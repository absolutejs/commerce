// Transactional email: a provider-agnostic send contract + a branded,
// email-client-safe HTML layout and the building blocks shops compose their
// order/shipping/proof/quote messages from. Copy stays in the app; the look and
// the plumbing live here.
//
// A provider adapter (e.g. @absolutejs/commerce-resend) implements EmailProvider.

import { fromCents } from "./money";

export type EmailMessage = { to: string; subject: string; html: string };

export type EmailProvider = {
  send(message: EmailMessage): Promise<void>;
};

export type EmailTheme = {
  brandName: string;
  tagline?: string;
  footerNote?: string;
  colors: {
    ink: string;
    accent: string;
    gold: string;
    paper: string;
    card: string;
    muted: string;
    hairline: string;
  };
};

// A neutral default palette; shops pass their own theme.
export const DEFAULT_EMAIL_THEME: EmailTheme = {
  brandName: "AbsoluteJS Commerce",
  colors: {
    accent: "#1f6f5c",
    card: "#fffdf8",
    gold: "#b5862f",
    hairline: "#e6ddcb",
    ink: "#1a1712",
    muted: "#7a7264",
    paper: "#efece4",
  },
  footerNote: "Questions? Just reply to this email.",
};

/** A short, human order reference derived from a session id. */
export const orderNumber = (sessionId: string) =>
  `#${sessionId.slice(-8).toUpperCase()}`;

/** Format a minor-unit amount for display (null → em dash). */
export const formatMoneyCents = (
  cents: number | null,
  currency: string | null = "usd",
) => {
  if (cents === null) return "—";
  const code = (currency ?? "usd").toUpperCase();
  const value = fromCents(cents).toFixed(2);

  return code === "USD" ? `$${value}` : `${value} ${code}`;
};

/** A carrier tracking URL, or '' for an unknown carrier. */
export const carrierTrackingUrl = (carrier: string, trackingNumber: string) => {
  const slug = carrier.toLowerCase();
  if (slug.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (slug.includes("ups"))
    return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (slug.includes("fedex"))
    return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;

  return "";
};

/** A branded call-to-action button (inline-styled for email clients). */
export const emailButton = (theme: EmailTheme, href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:${theme.colors.accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:6px;">${label}</a>`;

export type EmailLineItem = { label: string; amountCents: number };

export type LineItemsOptions = {
  currency?: string | null;
  totalCents?: number | null;
  totalLabel?: string;
};

/** A line-items table with an optional total row. */
export const emailLineItems = (
  theme: EmailTheme,
  items: EmailLineItem[],
  options: LineItemsOptions = {},
) => {
  const { colors } = theme;
  const rows = items
    .map(
      (item) =>
        `<tr>
					<td style="padding:8px 0;border-bottom:1px solid ${colors.hairline};font-size:14px;color:${colors.ink};">${item.label}</td>
					<td style="padding:8px 0;border-bottom:1px solid ${colors.hairline};text-align:right;font-family:monospace;font-size:14px;color:${colors.ink};">${formatMoneyCents(item.amountCents, options.currency)}</td>
				</tr>`,
    )
    .join("");
  const total =
    options.totalCents === undefined
      ? ""
      : `<tr>
				<td style="padding:12px 0 0;font-weight:700;font-size:15px;color:${colors.ink};">${options.totalLabel ?? "Total"}</td>
				<td style="padding:12px 0 0;text-align:right;font-weight:700;font-family:monospace;font-size:15px;color:${colors.ink};">${formatMoneyCents(options.totalCents, options.currency)}</td>
			</tr>`;

  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;">${rows}${total}</table>`;
};

export type RenderEmailArgs = {
  preheader: string;
  heading: string;
  intro: string;
  /** Pre-built inner HTML (line tables, buttons, paragraphs). */
  inner?: string;
};

/** Wrap content in the branded, responsive email shell. */
export const renderEmail = (
  theme: EmailTheme,
  { preheader, heading, intro, inner = "" }: RenderEmailArgs,
) => {
  const { colors } = theme;
  const tagline = theme.tagline ? ` · ${theme.tagline}` : "";
  const footer = theme.footerNote ?? "";

  return `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<div style="margin:0;padding:24px 12px;background:${colors.paper};font-family:'Helvetica Neue',Arial,sans-serif;">
	<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
		<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${colors.card};border:1.5px solid ${colors.ink};">
			<tr><td style="height:6px;background:${colors.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
			<tr><td style="padding:24px 28px 4px;">
				<span style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:${colors.gold};font-weight:700;">${theme.brandName}</span>
			</td></tr>
			<tr><td style="padding:8px 28px 28px;">
				<h1 style="margin:0 0 10px;font-size:26px;line-height:1.15;color:${colors.accent};">${heading}</h1>
				<p style="margin:0 0 4px;font-size:15px;line-height:1.55;color:${colors.ink};">${intro}</p>
				${inner}
			</td></tr>
			<tr><td style="padding:18px 28px;border-top:1px solid ${colors.hairline};font-family:'Courier New',monospace;font-size:11px;line-height:1.6;color:${colors.muted};">
				${theme.brandName}${tagline}<br/>
				${footer}
			</td></tr>
		</table>
	</td></tr></table>
</div>`;
};
