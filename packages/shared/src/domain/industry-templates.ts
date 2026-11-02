export const INDUSTRY_TEMPLATE_CODES = {
  coffeeShop: "coffee_shop",
  retailStore: "retail_store"
} as const;

export type IndustryTemplateCode =
  (typeof INDUSTRY_TEMPLATE_CODES)[keyof typeof INDUSTRY_TEMPLATE_CODES];

export type IndustryTemplateDefinition = {
  code: IndustryTemplateCode;
  label: string;
  shortLabel: string;
  note: string;
  roles: string[];
};

export const INDUSTRY_TEMPLATE_OPTIONS: IndustryTemplateDefinition[] = [
  {
    code: INDUSTRY_TEMPLATE_CODES.coffeeShop,
    label: "Кофейня и кофейная розница",
    shortLabel: "Кофейня",
    note: "Текущий рабочий шаблон пилотной LMS.",
    roles: ["Бариста-кассир", "Старший бариста", "Управляющий точки"]
  },
  {
    code: INDUSTRY_TEMPLATE_CODES.retailStore,
    label: "Розничный магазин",
    shortLabel: "Ритейл",
    note: "Временный второй MVP-шаблон для быстрой проверки multi-industry контура.",
    roles: ["Продавец-кассир", "Старший смены", "Администратор магазина"]
  }
];

export const DEFAULT_INDUSTRY_TEMPLATE = INDUSTRY_TEMPLATE_CODES.coffeeShop;

export function getIndustryTemplateLabel(code: string): string {
  return (
    INDUSTRY_TEMPLATE_OPTIONS.find((item) => item.code === code)?.label ??
    INDUSTRY_TEMPLATE_OPTIONS[0].label
  );
}

export function getIndustryTemplateShortLabel(code: string): string {
  return (
    INDUSTRY_TEMPLATE_OPTIONS.find((item) => item.code === code)?.shortLabel ??
    "Шаблон не выбран"
  );
}

export function isIndustryTemplateCode(value: string): value is IndustryTemplateCode {
  return INDUSTRY_TEMPLATE_OPTIONS.some((item) => item.code === value);
}
