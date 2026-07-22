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

export type StorefrontCaseAttachmentPurpose =
  | "customer_communication"
  | "customer_signature"
  | "receipt"
  | "refund_policy"
  | "service_documentation"
  | "shipping_documentation"
  | "uncategorized_file";

export type StorefrontCaseAttachmentStatus =
  | "clean"
  | "deleted"
  | "infected"
  | "pending_scan"
  | "quarantined"
  | "scanning";

export type StorefrontCaseEvidenceText = Partial<{
  accessActivityLog: string;
  billingAddress: string;
  cancellationPolicyDisclosure: string;
  cancellationRebuttal: string;
  customerEmailAddress: string;
  customerName: string;
  customerPurchaseIp: string;
  duplicateChargeExplanation: string;
  duplicateChargeId: string;
  productDescription: string;
  refundPolicyDisclosure: string;
  refundRefusalExplanation: string;
  serviceDate: string;
  shippingAddress: string;
  shippingCarrier: string;
  shippingDate: string;
  shippingTrackingNumber: string;
  uncategorizedText: string;
}>;

export type StorefrontCaseResolution = {
  instructions?: string;
  kind: StorefrontCaseResolutionKind;
  note: string;
  orderActionId?: string;
  replacementReference?: string;
};
