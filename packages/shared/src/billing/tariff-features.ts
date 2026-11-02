export const TARIFF_CODES = {
  base: "base",
  extended: "extended",
  corporate: "corporate"
} as const;

export type TariffCode = (typeof TARIFF_CODES)[keyof typeof TARIFF_CODES];

export type TariffFeatures = {
  code: TariffCode;
  label: string;
  maxAdmins: number;
  includedUsers: number;
  aiAssistant: boolean;
  advancedAnalytics: boolean;
  documentTemplates: boolean;
  excelExport: boolean;
  apiExport: boolean;
  multiBranch: boolean;
  branding: boolean;
  slaHours: number | null;
};

export const TARIFF_FEATURES: Record<TariffCode, TariffFeatures> = {
  base: {
    code: TARIFF_CODES.base,
    label: "Base",
    maxAdmins: 1,
    includedUsers: 5,
    aiAssistant: false,
    advancedAnalytics: false,
    documentTemplates: false,
    excelExport: false,
    apiExport: false,
    multiBranch: false,
    branding: false,
    slaHours: null
  },
  extended: {
    code: TARIFF_CODES.extended,
    label: "Extended",
    maxAdmins: 3,
    includedUsers: 5,
    aiAssistant: true,
    advancedAnalytics: true,
    documentTemplates: true,
    excelExport: true,
    apiExport: false,
    multiBranch: false,
    branding: false,
    slaHours: null
  },
  corporate: {
    code: TARIFF_CODES.corporate,
    label: "Corporate",
    maxAdmins: 5,
    includedUsers: 5,
    aiAssistant: true,
    advancedAnalytics: true,
    documentTemplates: true,
    excelExport: true,
    apiExport: true,
    multiBranch: true,
    branding: true,
    slaHours: 4
  }
};

export function isTariffCode(value: string): value is TariffCode {
  return value in TARIFF_FEATURES;
}

export function getTariffFeatures(tariff: string): TariffFeatures {
  if (isTariffCode(tariff)) {
    return TARIFF_FEATURES[tariff];
  }

  return TARIFF_FEATURES.base;
}
