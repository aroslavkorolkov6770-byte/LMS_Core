import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { RoleCode } from "@lms-core/shared";

export type RequestUser = {
  userId: string;
  clientId: string;
  roleCode: RoleCode;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | undefined => {
    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();

    return request.user;
  }
);
