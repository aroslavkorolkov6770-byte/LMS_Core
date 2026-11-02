import { DEFAULT_INDUSTRY_TEMPLATE } from "./industry-options";

type IndustryCard = {
  title: string;
  desc: string;
};

type IndustryContent = {
  code: string;
  homeBadge: string;
  homeTitle: string;
  homeSubtitle: string;
  featureCards: IndustryCard[];
  dashboardTitle: string;
  dashboardCaption: string;
  theoryLabel: string;
  assortmentLabel: string;
  productsLabel: string;
  documentsLabel: string;
  assistantLabel: string;
  roleTrackLabel: string;
  roleTrackItems: string[];
  assistantPrompts: string[];
  assistantHelperText: string;
};

const INDUSTRY_CONTENT: Record<string, IndustryContent> = {
  coffee_shop: {
    code: "coffee_shop",
    homeBadge: "LMS для кофейни",
    homeTitle: "Сервис, стандарты и адаптация команды",
    homeSubtitle:
      "Контур для кофейни и кофейной розницы: обучение по ролям, ассортимент, документы и AI-помощник по регламентам точки.",
    featureCards: [
      {
        title: "Обучение по ролям",
        desc: "Маршруты для бариста-кассира, старшего бариста и управляющего точки."
      },
      {
        title: "Ассортимент и сервис",
        desc: "Материалы по кофе, напиткам, стандартам обслуживания и допродажам."
      },
      {
        title: "Проверка знаний",
        desc: "Тесты, документы и быстрые подсказки для ежедневной работы смены."
      }
    ],
    dashboardTitle: "Центр подготовки команды кофейни",
    dashboardCaption: "Динамика адаптации, сервиса и знания товарной матрицы.",
    theoryLabel: "Теория кофейной точки",
    assortmentLabel: "Ассортимент",
    productsLabel: "Продукты и SKU",
    documentsLabel: "Регламенты и документы",
    assistantLabel: "AI помощник смены",
    roleTrackLabel: "Стартовые роли",
    roleTrackItems: ["Бариста-кассир", "Старший бариста", "Управляющий точки"],
    assistantPrompts: [
      "Как действовать, если гость недоволен напитком?",
      "Что делать, если сломалась кофемашина?",
      "Как быстро объяснить разницу между эспрессо-смесями?"
    ],
    assistantHelperText:
      "Задайте вопрос по сервису, регламентам смены, напиткам или товарной матрице кофейни."
  },
  retail_store: {
    code: "retail_store",
    homeBadge: "LMS для розничного магазина",
    homeTitle: "Продажи, стандарты зала и адаптация персонала",
    homeSubtitle:
      "Контур для розничного магазина: ввод в ассортимент, правила работы в зале, документы и AI-помощник по процессам магазина.",
    featureCards: [
      {
        title: "Обучение персонала зала",
        desc: "Маршруты для продавца-кассира, старшего смены и администратора магазина."
      },
      {
        title: "Каталог и выкладка",
        desc: "Знание товарных групп, сценариев продаж, выкладки и навигации по магазину."
      },
      {
        title: "Контроль операций",
        desc: "Чек-листы, документы и тесты по стандартам обслуживания и кассовой дисциплине."
      }
    ],
    dashboardTitle: "Центр подготовки команды магазина",
    dashboardCaption: "Динамика адаптации, знания каталога и стандартов торгового зала.",
    theoryLabel: "Теория магазина",
    assortmentLabel: "Каталог и категории",
    productsLabel: "Товары и карточки",
    documentsLabel: "Инструкции и документы",
    assistantLabel: "AI помощник магазина",
    roleTrackLabel: "Стартовые роли",
    roleTrackItems: ["Продавец-кассир", "Старший смены", "Администратор магазина"],
    assistantPrompts: [
      "Как действовать при возврате товара без конфликта?",
      "Что проверить при открытии смены в магазине?",
      "Как объяснить покупателю разницу между категориями товара?"
    ],
    assistantHelperText:
      "Задайте вопрос по стандартам магазина, работе кассы, каталогу товаров или сценарию общения с покупателем."
  }
};

export function getIndustryContent(industryTemplate: string): IndustryContent {
  return INDUSTRY_CONTENT[industryTemplate] ?? INDUSTRY_CONTENT[DEFAULT_INDUSTRY_TEMPLATE];
}
