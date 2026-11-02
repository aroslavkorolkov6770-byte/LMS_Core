export declare const ROLE_CODES: {
    readonly employee: "employee";
    readonly clientAdmin: "client_admin";
    readonly systemAdmin: "system_admin";
};
export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];
export declare const CORE_ROLES: Array<{
    code: RoleCode;
    name: string;
    description: string;
}>;
