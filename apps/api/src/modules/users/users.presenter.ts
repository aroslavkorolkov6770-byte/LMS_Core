import { schema } from "@lms-core/db";

export type UserResponse = {
  id: string;
  clientId: string;
  roleId: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function toUserResponse(user: typeof schema.users.$inferSelect): UserResponse {
  return {
    id: user.id,
    clientId: user.clientId,
    roleId: user.roleId,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}
