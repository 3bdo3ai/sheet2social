import { LicenseAdminPortal } from "@/components/license/admin-portal";
import { requireAdminLicenseSession } from "@/lib/license/auth";

export default async function AdminLicensesPage() {
  await requireAdminLicenseSession();

  return <LicenseAdminPortal />;
}
