/**
 * Upload service (Phase 2 placeholder).
 *
 * The Upload Document card in the popup is wired to this module only.
 * Nothing here touches the IREPS bill download flow. When the upload API
 * (SharePoint / OneDrive source, IREPS target workflow) is specified, the
 * implementation goes here and the popup does not need to change its
 * contract: uploadDocument() returns { ok, message }.
 */

export const UPLOAD_SOURCES = [
  { value: "sharepoint", label: "SharePoint" },
  { value: "onedrive", label: "OneDrive" },
  { value: "local", label: "Local File" }
];

export const DOCUMENT_TYPES = [
  { value: "invoice", label: "Invoice" },
  { value: "bill", label: "Bill" },
  { value: "delivery-challan", label: "Delivery Challan" },
  { value: "inspection-certificate", label: "Inspection Certificate" },
  { value: "other", label: "Other" }
];

/**
 * @param {{ source: string, documentType: string, file: { name: string, size: number, type: string } | null }} request
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function uploadDocument(request) {
  void request;
  return {
    ok: false,
    message: "Upload integration will be implemented in Phase 2."
  };
}
