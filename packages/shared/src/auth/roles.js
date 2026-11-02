"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORE_ROLES = exports.ROLE_CODES = void 0;
exports.ROLE_CODES = {
    employee: "employee",
    clientAdmin: "client_admin",
    systemAdmin: "system_admin"
};
exports.CORE_ROLES = [
    {
        code: exports.ROLE_CODES.employee,
        name: "Employee",
        description: "Проходит обучение, тесты, документы и использует AI в рамках своего клиента."
    },
    {
        code: exports.ROLE_CODES.clientAdmin,
        name: "Client Admin",
        description: "Управляет сотрудниками, контентом, дедлайнами и аналитикой клиента без доступа к инфраструктуре."
    },
    {
        code: exports.ROLE_CODES.systemAdmin,
        name: "System Admin",
        description: "Внутренняя роль команды для deploy, инфраструктуры, секретов и восстановления."
    }
];
