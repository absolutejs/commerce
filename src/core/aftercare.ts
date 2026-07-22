export type StorefrontCaseKind = "dispute" | "exchange" | "return" | "support";

export type StorefrontCaseStatus =
  | "approved"
  | "awaiting_customer"
  | "awaiting_merchant"
  | "closed"
  | "open"
  | "rejected"
  | "resolved"
  | "under_review";

export type StorefrontCaseResolutionKind =
  "denied" | "exchange" | "information" | "refund" | "repair" | "store_credit";

export type StorefrontCaseAttachment = {
  blobKey: string;
  label: string;
};

export type StorefrontCaseResolution = {
  instructions?: string;
  kind: StorefrontCaseResolutionKind;
  note: string;
  orderActionId?: string;
  replacementReference?: string;
};
