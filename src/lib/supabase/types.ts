export type LicenseStatus = "active" | "paused" | "expired" | "revoked";

export type Database = {
  public: {
    Tables: {
      license_keys: {
        Row: {
          id: string;
          key_string: string;
          status: LicenseStatus;
          device_id: string | null;
          valid_until: string;
          user_name: string | null;
          user_phone: string | null;
          user_email: string | null;
          admin_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key_string: string;
          status?: LicenseStatus;
          device_id?: string | null;
          valid_until: string;
          user_name?: string | null;
          user_phone?: string | null;
          user_email?: string | null;
          admin_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          key_string?: string;
          status?: LicenseStatus;
          device_id?: string | null;
          valid_until?: string;
          user_name?: string | null;
          user_phone?: string | null;
          user_email?: string | null;
          admin_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      license_status: LicenseStatus;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
