import { assetDisplayName, localizedAssetSector } from "@/lib/asset-display";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/formatters";
import { getMarketCopy, localeForLanguage, t, type Language } from "@/lib/i18n";
import type { CustomFundRecord, CustomFundUniverseItem, MarketId, Portfolio, PortfolioSummary } from "@/lib/types";

export type ReportPdfTheme = "light" | "dark";

type PortfolioPdfInput = {
  marketId: MarketId;
  language: Language;
  portfolio: Portfolio;
  summary: PortfolioSummary;
  generatedAt: Date;
  theme?: ReportPdfTheme;
  source?: string;
  updatedAt?: string;
};

type CustomFundPdfInput = {
  marketId: MarketId;
  language: Language;
  fund: CustomFundRecord;
  universe: CustomFundUniverseItem[];
  generatedAt: Date;
  theme?: ReportPdfTheme;
  universeCount?: number;
};

type TextOptions = {
  size?: number;
  color?: [number, number, number];
  width?: number;
  leading?: number;
};

const pageWidth = 595;
const pageHeight = 842;
const margin = 48;
type Rgb = [number, number, number];

type PdfPalette = {
  page: Rgb;
  panel: Rgb;
  card: Rgb;
  cardSoft: Rgb;
  border: Rgb;
  rule: Rgb;
  body: Rgb;
  heading: Rgb;
  muted: Rgb;
  subtle: Rgb;
  accent: Rgb;
  accent2: Rgb;
  positive: Rgb;
  negative: Rgb;
  barTrack: Rgb;
  tableHeader: Rgb;
};

const palettes: Record<ReportPdfTheme, PdfPalette> = {
  light: {
    page: [248, 250, 252],
    panel: [255, 255, 255],
    card: [249, 250, 251],
    cardSoft: [255, 255, 255],
    border: [226, 232, 240],
    rule: [229, 231, 235],
    body: [24, 24, 27],
    heading: [9, 15, 31],
    muted: [82, 82, 91],
    subtle: [113, 113, 122],
    accent: [13, 148, 136],
    accent2: [37, 99, 235],
    positive: [5, 150, 105],
    negative: [220, 38, 38],
    barTrack: [224, 231, 255],
    tableHeader: [244, 246, 248],
  },
  dark: {
    page: [2, 8, 7],
    panel: [11, 16, 18],
    card: [19, 25, 27],
    cardSoft: [15, 22, 24],
    border: [82, 82, 91],
    rule: [63, 63, 70],
    body: [212, 212, 216],
    heading: [250, 250, 250],
    muted: [161, 161, 170],
    subtle: [113, 113, 122],
    accent: [94, 234, 212],
    accent2: [125, 167, 255],
    positive: [110, 231, 183],
    negative: [253, 164, 175],
    barTrack: [39, 48, 52],
    tableHeader: [24, 31, 34],
  },
};

export function buildPortfolioPdf(input: PortfolioPdfInput) {
  const document = new PdfDocument(input.theme ?? "light");
  const generatedAt = formatGeneratedAt(input.generatedAt, input.language);

  document.cover("FUNDX", reportPdfTitle(input.portfolio.name, t(input.language, "reports.portfolioReport")), generatedAt, input.language);

  document.sectionTitle(t(input.language, "reports.reportOverview"));
  document.callout(buildPortfolioOverview(input.portfolio, input.summary, input.marketId, input.language));
  document.metadataGrid([
    [t(input.language, "common.market"), getMarketCopy(input.language, input.marketId).name],
    [t(input.language, "reports.reportRange"), formatReportRange(input.summary, input.language)],
    [t(input.language, "portfolio.capital"), formatOptionalCurrency(input.portfolio.capital, input.marketId)],
    [t(input.language, "common.totalValue"), formatCurrency(input.summary.totalValue, input.marketId)],
    [t(input.language, "common.risk"), input.portfolio.riskPreference || t(input.language, "common.no")],
    [t(input.language, "common.updated"), input.updatedAt ?? input.portfolio.updatedAt],
  ]);

  document.sectionTitle(t(input.language, "custom.weight"));
  document.weightBars(input.summary.holdings.slice(0, 10).map((holding) => ({
    label: holding.symbol,
    detail: holding.name,
    weight: holding.currentWeight,
    value: formatWeightValue(holding.currentWeight),
  })));

  document.sectionTitle(t(input.language, "reports.executiveSummary"));
  document.callout(buildPortfolioExecutiveSummary(input.portfolio, input.summary, input.marketId, input.language, formatReportRange(input.summary, input.language)));

  document.sectionTitle(t(input.language, "reports.keyMetrics"));
  document.metricGrid([
    [t(input.language, "common.totalValue"), formatCurrency(input.summary.totalValue, input.marketId)],
    [t(input.language, "common.totalGain"), formatCurrency(input.summary.totalGain, input.marketId)],
    [t(input.language, "common.totalReturn"), formatPercent(input.summary.totalGainPercent)],
    [t(input.language, "common.annualizedReturn"), formatPercent(input.summary.annualizedReturn)],
    [t(input.language, "compare.maxDrawdown"), formatPercent(input.summary.maxDrawdown)],
    [t(input.language, "compare.volatility"), formatPercent(input.summary.volatility)],
    [t(input.language, "reports.sharpeRatio"), formatNumber(input.summary.sharpeRatio, 2)],
    [t(input.language, "reports.topHolding"), formatWeightValue(input.summary.topHoldingConcentration)],
  ]);

  document.sectionTitle(t(input.language, "reports.holdingsBreakdown"));
  document.table(
    [
      t(input.language, "common.asset"),
      t(input.language, "common.symbol"),
      t(input.language, "common.value"),
      t(input.language, "custom.weight"),
      t(input.language, "common.gain"),
    ],
    input.summary.holdings.slice(0, 18).map((holding) => [
      holding.name,
      holding.symbol,
      formatCurrency(holding.marketValue, input.marketId),
      formatWeightValue(holding.currentWeight),
      `${formatCurrency(holding.gain, input.marketId)} / ${formatPercent(holding.gainPercent, 1)}`,
    ]),
    [185, 68, 95, 64, 118],
  );

  document.sectionTitle(t(input.language, "reports.exposureBreakdown"));
  document.twoColumnLists(
    t(input.language, "reports.sectorExposure"),
    input.summary.sectorExposure.slice(0, 10).map((item) => [localizedAssetSector(item.name, input.language) || item.name, formatWeightValue(item.weight)]),
    t(input.language, "reports.assetTypeExposure"),
    input.summary.assetTypeExposure.slice(0, 10).map((item) => [item.name, formatWeightValue(item.weight)]),
  );

  document.footer(
    [
      t(input.language, "reports.localOnlyNote"),
      input.updatedAt ? `${t(input.language, "common.updated")}: ${input.updatedAt}` : "",
    ].filter(Boolean).join("  "),
  );

  return document.toBlob();
}

export function buildCustomFundPdf(input: CustomFundPdfInput) {
  const document = new PdfDocument(input.theme ?? "light");
  const generatedAt = formatGeneratedAt(input.generatedAt, input.language);
  const score = input.fund.score;
  const assetById = new Map(input.universe.map((asset) => [asset.id, asset]));
  const backtest = score.backtestHistory ?? [];
  const firstPoint = backtest[0];
  const lastPoint = backtest[backtest.length - 1];
  const backtestReturn = firstPoint && lastPoint && firstPoint.value ? ((lastPoint.value - firstPoint.value) / firstPoint.value) * 100 : 0;

  document.cover("FUNDX", reportPdfTitle(input.fund.name, t(input.language, "reports.customFundReport")), generatedAt, input.language);

  document.sectionTitle(t(input.language, "reports.reportOverview"));
  document.callout(buildCustomFundOverview(input.fund, backtestReturn, input.language));
  document.metadataGrid([
    [t(input.language, "common.market"), getMarketCopy(input.language, input.marketId).name],
    [t(input.language, "reports.reportRange"), firstPoint && lastPoint ? `${firstPoint.date} - ${lastPoint.date}` : t(input.language, "custom.backtestSubtitle")],
    [t(input.language, "custom.style"), input.fund.style],
    [t(input.language, "reports.version"), formatNumber(input.fund.version)],
    [t(input.language, "reports.holdingsCount"), formatNumber(input.fund.holdings.length)],
    [t(input.language, "common.updated"), input.fund.updatedAt],
  ]);

  document.sectionTitle(t(input.language, "custom.weight"));
  document.weightBars(input.fund.holdings.slice(0, 10).map((holding) => {
    const asset = assetById.get(holding.stockId);
    return {
      label: asset?.symbol ?? holding.stockId,
      detail: asset ? assetDisplayName(asset, input.language) : holding.stockId,
      weight: holding.weight,
      value: formatWeightValue(holding.weight),
    };
  }));

  document.sectionTitle(t(input.language, "reports.executiveSummary"));
  document.callout(buildCustomFundExecutiveSummary(
    input.fund,
    score,
    backtestReturn,
    input.language,
    firstPoint && lastPoint ? `${firstPoint.date} - ${lastPoint.date}` : t(input.language, "custom.backtestSubtitle"),
  ));

  document.sectionTitle(t(input.language, "reports.scoringBreakdown"));
  document.metricGrid([
    [t(input.language, "common.targetWeight"), formatWeightValue(score.totalWeight)],
    [t(input.language, "compare.dividendYield"), formatPercent(score.dividendYield)],
    [t(input.language, "compare.volatility"), formatPercent(score.volatility)],
    [t(input.language, "compare.maxDrawdown"), formatPercent(score.maxDrawdown)],
    [t(input.language, "custom.valueScore"), formatNumber(score.valueScore, 1)],
    [t(input.language, "custom.quality"), formatNumber(score.qualityScore, 1)],
    [t(input.language, "custom.dividendScore"), formatNumber(score.dividendScore, 1)],
    [t(input.language, "common.riskScore"), formatNumber(score.riskScore, 1)],
    [t(input.language, "reports.concentrationScore"), formatNumber(score.concentrationScore, 1)],
    [t(input.language, "reports.peRatio"), formatNumber(score.peRatio, 2)],
    [t(input.language, "reports.pbRatio"), formatNumber(score.pbRatio, 2)],
    [t(input.language, "reports.roe"), formatPercent(score.roe)],
  ]);

  document.sectionTitle(t(input.language, "reports.constituents"));
  document.table(
    [
      t(input.language, "common.asset"),
      t(input.language, "common.symbol"),
      t(input.language, "custom.weight"),
      t(input.language, "reports.sectorExposure"),
      t(input.language, "compare.dividendYield"),
    ],
    input.fund.holdings.slice(0, 20).map((holding) => {
      const asset = assetById.get(holding.stockId);
      return [
        asset ? assetDisplayName(asset, input.language) : holding.stockId,
        asset?.symbol ?? "-",
        formatWeightValue(holding.weight),
        asset ? localizedAssetSector(asset.sector, input.language) : "-",
        asset ? formatPercent(asset.dividendYield) : "-",
      ];
    }),
    [178, 66, 62, 125, 88],
  );

  document.sectionTitle(t(input.language, "reports.exposureBreakdown"));
  document.table(
    [t(input.language, "reports.sectorExposure"), t(input.language, "custom.weight")],
    score.sectorExposure.slice(0, 12).map((item) => [localizedAssetSector(item.name, input.language) || item.name, formatWeightValue(item.weight)]),
    [260, 100],
  );

  document.footer(`${t(input.language, "reports.localOnlyNote")}  ${t(input.language, "custom.holdingsSubtitle")}`);
  return document.toBlob();
}

export function reportPdfFilename(name: string, kind: "portfolio" | "customFund", generatedAt: Date) {
  const date = localDateStamp(generatedAt);
  const slug = name.trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || kind;
  return `fundx-${kind === "portfolio" ? "portfolio" : "custom-fund"}-${slug}-${date}.pdf`;
}

function localDateStamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatGeneratedAt(date: Date, language: Language) {
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatReportRange(summary: PortfolioSummary, language: Language) {
  if (summary.rangeStartDate && summary.rangeEndDate) {
    return `${summary.rangeStartDate} - ${summary.rangeEndDate}`;
  }
  return summary.range ?? t(language, "common.history");
}

function formatOptionalCurrency(value: number | null | undefined, marketId: MarketId) {
  return value == null ? "-" : formatCurrency(value, marketId);
}

function reportPdfTitle(name: string, reportType: string) {
  return `${name} ${reportType}`;
}

function buildPortfolioOverview(portfolio: Portfolio, summary: PortfolioSummary, marketId: MarketId, language: Language) {
  const allocation = summary.holdings.slice(0, 5).map((holding) => `${holding.symbol} ${formatWeightValue(holding.currentWeight)}`).join(", ");
  const rangeReturn = formatPercent(summary.rangeGainPercent ?? summary.totalGainPercent);
  if (language === "en") {
    return `Current allocation is ${allocation || "-"}. Portfolio value is ${formatCurrency(summary.totalValue, marketId)}, range return is ${rangeReturn}, and max drawdown is ${formatPercent(summary.maxDrawdown)}.`;
  }
  return `当前配置为 ${allocation || "-"}。组合当前价值 ${formatCurrency(summary.totalValue, marketId)}，区间回报 ${rangeReturn}，最大回撤 ${formatPercent(summary.maxDrawdown)}。${portfolio.goal ? `目标为 ${portfolio.goal}。` : ""}`;
}

function buildPortfolioExecutiveSummary(portfolio: Portfolio, summary: PortfolioSummary, marketId: MarketId, language: Language, reportRange: string) {
  const symbols = summary.holdings.slice(0, 6).map((holding) => holding.symbol).join(", ");
  const topHolding = summary.holdings[0];
  if (language === "en") {
    return `This report covers ${formatNumber(summary.holdings.length)} holdings${symbols ? ` (${symbols})` : ""}, with sample range ${reportRange}. Total gain is ${formatCurrency(summary.totalGain, marketId)} (${formatPercent(summary.totalGainPercent)}), volatility is ${formatPercent(summary.volatility)}, and the largest position is ${topHolding ? `${topHolding.symbol} at ${formatWeightValue(topHolding.currentWeight)}` : "-"}. Risk preference: ${portfolio.riskPreference || "-"}.`;
  }
  return `本报告覆盖 ${formatNumber(summary.holdings.length)} 个标的${symbols ? `（${symbols}）` : ""}，样本区间为 ${reportRange}。总收益为 ${formatCurrency(summary.totalGain, marketId)}（${formatPercent(summary.totalGainPercent)}），波动率 ${formatPercent(summary.volatility)}，最大持仓为 ${topHolding ? `${topHolding.symbol} ${formatWeightValue(topHolding.currentWeight)}` : "-"}。风险偏好为 ${portfolio.riskPreference || "-"}。`;
}

function buildCustomFundOverview(fund: CustomFundRecord, backtestReturn: number, language: Language) {
  const score = fund.score;
  if (language === "en") {
    return `The saved custom fund holds ${formatNumber(fund.holdings.length)} constituents with ${formatWeightValue(score.totalWeight)} target weight. Backtest return is ${formatPercent(backtestReturn, 1)}, dividend yield is ${formatPercent(score.dividendYield)}, and max drawdown is ${formatPercent(score.maxDrawdown)}.`;
  }
  return `该自定义基金持有 ${formatNumber(fund.holdings.length)} 个成分，目标权重合计 ${formatWeightValue(score.totalWeight)}。回测收益 ${formatPercent(backtestReturn, 1)}，股息率 ${formatPercent(score.dividendYield)}，最大回撤 ${formatPercent(score.maxDrawdown)}。`;
}

function buildCustomFundExecutiveSummary(fund: CustomFundRecord, score: CustomFundRecord["score"], backtestReturn: number, language: Language, reportRange: string) {
  const symbols = fund.holdings.slice(0, 6).map((holding) => holding.stockId).join(", ");
  if (language === "en") {
    return `This report covers ${formatNumber(fund.holdings.length)} selected securities${symbols ? ` (${symbols})` : ""} over ${reportRange}. The model shows ${formatPercent(backtestReturn, 1)} backtest return, ${formatNumber(score.valueScore, 1)} value score, ${formatNumber(score.qualityScore, 1)} quality score, and ${formatPercent(score.volatility)} volatility.`;
  }
  return `本报告覆盖 ${formatNumber(fund.holdings.length)} 个成分${symbols ? `（${symbols}）` : ""}，样本区间为 ${reportRange}。模型显示回测收益 ${formatPercent(backtestReturn, 1)}，价值评分 ${formatNumber(score.valueScore, 1)}，质量评分 ${formatNumber(score.qualityScore, 1)}，波动率 ${formatPercent(score.volatility)}。`;
}

function formatWeightValue(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

class PdfDocument {
  private pages: string[][] = [];
  private commands: string[] = [];
  private readonly palette: PdfPalette;
  y = pageHeight - margin;

  constructor(theme: ReportPdfTheme) {
    this.palette = palettes[theme];
    this.startPage();
  }

  cover(badge: string, title: string, generatedAt: string, language: Language) {
    const badgeWidth = Math.max(96, visualLength(badge) * 6 + 24);
    this.box(margin, this.y - 18, badgeWidth, 20, this.palette.cardSoft, this.palette.border);
    this.drawText(badge, margin + 12, this.y - 5, { size: 9, color: this.palette.accent, width: badgeWidth - 24, leading: 11 });
    this.drawText(title, margin, this.y - 54, {
      size: 22,
      color: this.palette.heading,
      width: 365,
      leading: 27,
    });
    this.box(pageWidth - margin - 140, this.y - 66, 140, 52, this.palette.cardSoft, this.palette.border);
    this.drawText(t(language, "reports.generatedAt"), pageWidth - margin - 128, this.y - 30, { size: 9, color: this.palette.heading, width: 112, leading: 11 });
    this.drawText(generatedAt, pageWidth - margin - 128, this.y - 46, { size: 9, color: this.palette.body, width: 116, leading: 12 });
    this.rule(this.y - 84);
  }

  text(value: string, x: number, y: number, options: TextOptions = {}) {
    const size = options.size ?? 11;
    const leading = options.leading ?? size + 5;
    const width = options.width ?? pageWidth - margin * 2;
    const lines = wrapText(value, width, size);
    this.ensure(lines.length * leading + 4);
    this.drawTextLines(lines, x, y, size, leading, options.color ?? this.palette.body);
    this.y = y - lines.length * leading;
  }

  sectionTitle(value: string) {
    this.ensure(44);
    this.y -= 14;
    this.text(value, margin, this.y, { size: 15, color: this.palette.heading, leading: 18 });
    this.y -= 2;
  }

  callout(value: string) {
    const width = pageWidth - margin * 2;
    const lines = wrapText(value, width - 28, 11);
    const height = Math.max(42, lines.length * 15 + 22);
    this.ensure(height + 8);
    const y = this.y;
    this.box(margin, y - height + 4, width, height, this.palette.card, this.palette.border);
    this.drawTextLines(lines, margin + 14, y - 14, 11, 15, this.palette.body);
    this.y = y - height - 8;
  }

  metadataGrid(rows: Array<[string, string]>) {
    const columnWidth = (pageWidth - margin * 2 - 26) / 2;
    rows.forEach(([label, value], index) => {
      const column = index % 2;
      if (column === 0) this.ensure(46);
      const x = margin + column * (columnWidth + 26);
      const y = this.y;
      this.commands.push(`${rgb(this.palette.border)} RG ${number(x)} ${number(y - 34)} m ${number(x)} ${number(y)} l S`);
      this.drawText(label, x + 12, y - 10, { size: 9, color: this.palette.accent, width: columnWidth - 12, leading: 11 });
      this.drawText(value, x + 12, y - 27, { size: 12, color: this.palette.heading, width: columnWidth - 12, leading: 14 });
      if (column === 1 || index === rows.length - 1) this.y -= 48;
    });
  }

  weightBars(rows: Array<{ label: string; detail?: string; weight: number; value: string }>) {
    if (!rows.length) {
      this.text("-", margin, this.y, { size: 11, color: this.palette.muted });
      return;
    }
    rows.forEach((row) => {
      this.ensure(30);
      const y = this.y;
      this.drawText(row.label, margin, y - 3, { size: 12, color: this.palette.heading, width: 80, leading: 13 });
      if (row.detail) {
        this.drawText(row.detail, margin, y - 17, { size: 7, color: this.palette.muted, width: 80, leading: 9 });
      }
      const trackX = margin + 110;
      const trackWidth = pageWidth - margin * 2 - 168;
      this.box(trackX, y - 10, trackWidth, 7, this.palette.barTrack, this.palette.barTrack);
      this.box(trackX, y - 10, Math.max(2, trackWidth * (clampPercent(row.weight) / 100)), 7, this.palette.accent2, this.palette.accent2);
      this.drawText(row.value, pageWidth - margin - 48, y - 3, { size: 10, color: this.palette.heading, width: 48, leading: 12 });
      this.y -= 30;
    });
  }

  metricGrid(items: Array<[string, string]>) {
    const columnWidth = (pageWidth - margin * 2 - 18) / 2;
    items.forEach((item, index) => {
      const column = index % 2;
      if (column === 0) {
        this.ensure(58);
      }
      const x = margin + column * (columnWidth + 18);
      const y = this.y;
      this.box(x, y - 44, columnWidth, 46, this.palette.card, this.palette.border);
      this.drawText(item[0], x + 12, y - 14, { size: 9, color: this.palette.muted, width: columnWidth - 24, leading: 11 });
      this.drawText(item[1], x + 12, y - 29, { size: 13, color: this.valueColor(item[1]), width: columnWidth - 24, leading: 15 });
      if (column === 1 || index === items.length - 1) {
        this.y -= 58;
      }
    });
  }

  keyValueRows(rows: Array<[string, string]>) {
    rows.forEach(([label, value]) => {
      const valueLines = wrapText(value, 360, 10);
      const height = Math.max(20, valueLines.length * 13 + 6);
      this.ensure(height + 4);
      this.drawText(label, margin, this.y, { size: 9, color: this.palette.muted, width: 130, leading: 12 });
      this.drawTextLines(valueLines, margin + 145, this.y + 1, 10, 13, this.palette.body);
      this.y -= height;
    });
  }

  table(headers: string[], rows: string[][], widths: number[]) {
    if (!rows.length) {
      this.text("-", margin, this.y, { size: 11, color: this.palette.muted });
      return;
    }
    this.ensure(32);
    this.row(headers, widths, true);
    rows.forEach((row) => this.row(row, widths, false));
  }

  twoColumnLists(leftTitle: string, leftRows: string[][], rightTitle: string, rightRows: string[][]) {
    const columnWidth = (pageWidth - margin * 2 - 24) / 2;
    const required = Math.max(leftRows.length, rightRows.length) * 18 + 44;
    this.ensure(required);
    const topY = this.y;
    const leftHeight = this.list(leftTitle, leftRows, margin, columnWidth, topY);
    const rightHeight = this.list(rightTitle, rightRows, margin + columnWidth + 24, columnWidth, topY);
    this.y = topY - Math.max(leftHeight, rightHeight) - 16;
  }

  rule(y: number) {
    this.ensure(18);
    this.commands.push(`${rgb(this.palette.rule)} RG ${margin} ${number(y)} m ${pageWidth - margin} ${number(y)} l S`);
    this.y = y - 22;
  }

  footer(value: string) {
    this.pages.push(this.commands);
    this.pages = this.pages.map((commands, index) => [
      ...commands,
      `${rgb(this.palette.subtle)} rg BT /F1 8 Tf ${margin} 28 Td <${toUtf16Hex(value)}> Tj ET`,
      `${rgb(this.palette.subtle)} rg BT /F1 8 Tf ${pageWidth - margin - 40} 28 Td <${toUtf16Hex(String(index + 1))}> Tj ET`,
    ]);
    this.commands = [];
  }

  toBlob() {
    const pages = this.commands.length ? [...this.pages, this.commands] : this.pages;
    const objects: string[] = [];
    const pageObjectIds: number[] = [];
    const fontObjectId = 3;
    const cidFontObjectId = 4;
    let nextObjectId = 5;

    pages.forEach((commands) => {
      const content = commands.join("\n");
      const contentObjectId = nextObjectId++;
      const pageObjectId = nextObjectId++;
      objects[contentObjectId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      objects[pageObjectId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
      pageObjectIds.push(pageObjectId);
    });

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;
    objects[fontObjectId] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFontObjectId} 0 R] >>`;
    objects[cidFontObjectId] = "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>";

    const highestId = nextObjectId - 1;
    let body = "%PDF-1.4\n";
    const offsets = Array.from({ length: highestId + 1 }, () => 0);
    for (let id = 1; id <= highestId; id += 1) {
      offsets[id] = body.length;
      body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefOffset = body.length;
    body += `xref\n0 ${highestId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= highestId; id += 1) {
      body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${highestId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return new Blob([body], { type: "application/pdf" });
  }

  private list(title: string, rows: string[][], x: number, width: number, topY: number) {
    let currentY = topY;
    this.drawText(title, x, currentY, { size: 10, color: this.palette.muted, width, leading: 13 });
    currentY -= 20;
    rows.forEach(([name, value]) => {
      this.drawText(name, x, currentY, { size: 10, color: this.palette.body, width: width - 70, leading: 13 });
      this.drawText(value, x + width - 62, currentY, { size: 10, color: this.palette.body, width: 62, leading: 13 });
      currentY -= 18;
    });
    return topY - currentY;
  }

  private row(cells: string[], widths: number[], header: boolean) {
    const size = header ? 8 : 9;
    const leading = header ? 10 : 11;
    const maxLines = Math.max(...cells.map((cell, index) => wrapText(cell, widths[index] - 10, size).length), 1);
    const height = header ? 22 : Math.max(24, maxLines * leading + 10);
    this.ensure(height + 2);
    const y = this.y;
    if (header) {
      this.box(margin, y - 17, widths.reduce((sum, item) => sum + item, 0), 22, this.palette.tableHeader, this.palette.border);
    }
    let x = margin;
    cells.forEach((cell, index) => {
      this.drawText(cell, x + 5, y - (header ? 9 : 10), {
        size,
        color: header ? this.palette.muted : this.palette.body,
        width: widths[index] - 10,
        leading,
      });
      x += widths[index];
    });
    this.y = y - height;
  }

  private box(x: number, y: number, width: number, height: number, fill: [number, number, number], stroke: [number, number, number]) {
    this.commands.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${number(x)} ${number(y)} ${number(width)} ${number(height)} re B`);
  }

  private setColor(color: [number, number, number]) {
    this.commands.push(`${rgb(color)} rg`);
  }

  private drawText(value: string, x: number, y: number, options: TextOptions = {}) {
    const size = options.size ?? 11;
    const leading = options.leading ?? size + 5;
    const width = options.width ?? pageWidth - margin * 2;
    this.drawTextLines(wrapText(value, width, size), x, y, size, leading, options.color ?? this.palette.body);
  }

  private drawTextLines(lines: string[], x: number, y: number, size: number, leading: number, color: [number, number, number]) {
    this.setColor(color);
    lines.forEach((line, index) => {
      this.commands.push(`BT /F1 ${number(size)} Tf ${number(x)} ${number(y - index * leading)} Td <${toUtf16Hex(line)}> Tj ET`);
    });
  }

  private ensure(height: number) {
    if (this.y - height > margin + 22) return;
    this.pages.push(this.commands);
    this.startPage();
  }

  private startPage() {
    this.commands = [
      `${rgb(this.palette.page)} rg 0 0 ${pageWidth} ${pageHeight} re f`,
      `${rgb(this.palette.panel)} rg ${rgb(this.palette.border)} RG 32 38 531 764 re B`,
    ];
    this.y = pageHeight - 72;
  }

  private valueColor(value: string): Rgb {
    const trimmed = value.trim();
    if (trimmed.startsWith("-")) return this.palette.negative;
    if (trimmed.startsWith("+")) return this.palette.positive;
    return this.palette.heading;
  }
}

function wrapText(value: string, width: number, size: number) {
  const maxUnits = Math.max(8, Math.floor(width / (size * 0.58)));
  const lines: string[] = [];
  let current = "";
  Array.from(value).forEach((char) => {
    const candidate = current + char;
    if (visualLength(candidate) <= maxUnits || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = char;
  });
  if (current) lines.push(current);
  return lines;
}

function visualLength(value: string) {
  return Array.from(value).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.7 : 1), 0);
}

function toUtf16Hex(value: string) {
  return Array.from(value).map((char) => {
    const codePoint = char.codePointAt(0) ?? 63;
    const code = codePoint > 0xffff ? 63 : codePoint;
    return code.toString(16).toUpperCase().padStart(4, "0");
  }).join("");
}

function rgb(color: [number, number, number]) {
  return color.map((value) => number(value / 255)).join(" ");
}

function number(value: number) {
  return Number(value.toFixed(3)).toString();
}
