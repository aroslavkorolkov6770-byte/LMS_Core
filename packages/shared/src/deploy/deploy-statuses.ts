export const DEPLOY_STATUSES = {
  draft: "draft",
  validated: "validated",
  readyToDeploy: "ready_to_deploy",
  deployed: "deployed"
} as const;

export type DeployStatus = (typeof DEPLOY_STATUSES)[keyof typeof DEPLOY_STATUSES];

export const DEPLOY_STATUS_OPTIONS: Array<{
  code: DeployStatus;
  label: string;
}> = [
  {
    code: DEPLOY_STATUSES.draft,
    label: "Черновик"
  },
  {
    code: DEPLOY_STATUSES.validated,
    label: "Проверено"
  },
  {
    code: DEPLOY_STATUSES.readyToDeploy,
    label: "Готово к деплою"
  },
  {
    code: DEPLOY_STATUSES.deployed,
    label: "Развернуто"
  }
];

export function isDeployStatus(value: string): value is DeployStatus {
  return DEPLOY_STATUS_OPTIONS.some((item) => item.code === value);
}

export function getDeployStatusLabel(status: string): string {
  return DEPLOY_STATUS_OPTIONS.find((item) => item.code === status)?.label ?? "Неизвестно";
}
