/**
 * @deprecated (remove after 2026-07-01):
 *  - Generic primitives (DataTable, Pagination, Tabs, ToastProvider, useToast, ConfirmDialog, FormDialog)
 *    da chuyen sang `@/shared/ui/primitives`.
 *  - Admin-specific card (AdminSidebarCard, AdminSectionCard) da chuyen sang
 *    `@/features/document-workflow/admin/components/AdminCards`.
 * Code moi PHAI import truc tiep tu vi tri moi. File nay chi lam re-export shim tam thoi.
 */
export {
  DataTable,
  Pagination,
  Tabs,
  ToastProvider,
  useToast,
  ConfirmDialog,
  FormDialog,
} from "@/shared/ui/primitives";

export {
  AdminSidebarCard,
  AdminSectionCard,
} from "@/features/document-workflow/admin/components/AdminCards";
