export const DEFAULT_INDUSTRY_TEMPLATE = "coffee_shop";

export const INDUSTRY_TEMPLATE_OPTIONS = [
  {
    code: "coffee_shop",
    label: "Кофейня и кофейная розница",
    shortLabel: "Кофейня",
    roles: ["Бариста-кассир", "Старший бариста", "Управляющий точки"]
  },
  {
    code: "retail_store",
    label: "Розничный магазин",
    shortLabel: "Ритейл",
    roles: ["Продавец-кассир", "Старший смены", "Администратор магазина"]
  }
] as const;

export function getIndustryTemplateShortLabel(code: string): string {
  return (
    INDUSTRY_TEMPLATE_OPTIONS.find((item) => item.code === code)?.shortLabel ??
    "Шаблон не выбран"
  );
}
