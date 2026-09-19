export const UserRole = {
  SUPERVISOR: "supervisor",
  ADMIN: "admin",
  MANAGER: "manager",
  /**
   * The platform owner, above every tenant. Not a tenant-local role: a vendor
   * lists customers and enters one, and no customer's own user may ever hold it.
   */
  VENDOR: "vendor",
} as const;

export type UserRoleType = (typeof UserRole)[keyof typeof UserRole];

export interface User {
  id: string;
  phone: string;
  role: UserRoleType;
  isActive: boolean;
  createdAt: string;
}
