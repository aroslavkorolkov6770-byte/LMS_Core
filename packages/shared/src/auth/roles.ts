export const ROLE_CODES = {
  employee: "employee",
  clientAdmin: "client_admin",
  systemAdmin: "system_admin"
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

export const CORE_ROLES: Array<{
  code: RoleCode;
  name: string;
  description: string;
}> = [
  {
    code: ROLE_CODES.employee,
    name: "Employee",
    description: "Проходит обучение, тесты, документы и использует AI в рамках своего клиента."
  },
  {
    code: ROLE_CODES.clientAdmin,
    name: "Client Admin",
    description: "Управляет сотрудниками, контентом, дедлайнами и аналитикой клиента без доступа к инфраструктуре."
  },
  {
    code: ROLE_CODES.systemAdmin,
    name: "System Admin",
    description: "Внутренняя роль команды для deploy, инфраструктуры, секретов и восстановления."
  }
];
