import { CYCLICAL_SECTORS, DEFENSIVE_SECTORS, TRADING_DAYS_PER_YEAR } from "./constants";
import type {
  CustomFundHolding,
  CustomFundScore,
  DcaCashFlow,
  DcaInput,
  DcaSimulation,
  Exposure,
  Fund,
  Holding,
  Insight,
  MarketId,
  Portfolio,
  PortfolioSummary,
  Stock,
  TimePoint,
} from "./types";
import {
  assertSameMarket,
  buildContributionDates,
  clamp,
  daysBetween,
  filterHistoryByDateRange,
  groupWeight,
  normalizeWeights,
  round,
  sortHistory,
  sumBy,
  weightedAverage,
  yearsBetween,
} from "./utils";

const TARGET_RETURN_ANNUAL_RATE = 0.08;

export type DrawdownResult = {
  maxDrawdown: number;
  startDate: string;
  bottomDate: string;
  recoveryDate: string | null;
  durationDays: number;
  drawdownHistory: TimePoint[];
};

export function calculateReturn(startValue: number, endValue: number): number {
  if (startValue === 0) return 0;
  return ((endValue - startValue) / startValue) * 100;
}

export function calculateCumulativeReturn(history: TimePoint[]): number {
  const sorted = sortHistory(history);
  const first = sorted[0];
  const last = sorted.at(-1);
  return first && last ? round(calculateReturn(first.value, last.value), 2) : 0;
}

export function calculateAnnualizedReturn(
  startValue: number,
  endValue: number,
  startDate: string,
  endDate: string,
): number {
  const years = yearsBetween(startDate, endDate);
  if (startValue <= 0 || endValue <= 0 || years <= 0) return 0;
  return round(((endValue / startValue) ** (1 / years) - 1) * 100, 2);
}

export function calculateDrawdown(history: TimePoint[]): DrawdownResult {
  const sorted = sortHistory(history);
  if (sorted.length === 0) {
    return {
      maxDrawdown: 0,
      startDate: "",
      bottomDate: "",
      recoveryDate: null,
      durationDays: 0,
      drawdownHistory: [],
    };
  }

  let peak = sorted[0].value;
  let peakDate = sorted[0].date;
  let maxDrawdown = 0;
  let startDate = sorted[0].date;
  let bottomDate = sorted[0].date;
  let recoveryDate: string | null = null;
  const drawdownHistory: TimePoint[] = [];

  for (const point of sorted) {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }

    const drawdown = peak === 0 ? 0 : ((point.value - peak) / peak) * 100;
    drawdownHistory.push({ date: point.date, value: round(drawdown, 2) });

    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      startDate = peakDate;
      bottomDate = point.date;
      recoveryDate = null;
    }

    if (!recoveryDate && maxDrawdown < 0 && point.date > bottomDate && point.value >= peak) {
      recoveryDate = point.date;
    }
  }

  return {
    maxDrawdown: round(maxDrawdown, 2),
    startDate,
    bottomDate,
    recoveryDate,
    durationDays: daysBetween(startDate, recoveryDate ?? sorted.at(-1)!.date),
    drawdownHistory,
  };
}

export const calculateMaxDrawdown = calculateDrawdown;

export function calculateVolatility(history: TimePoint[]): number {
  const sorted = sortHistory(history);
  if (sorted.length < 2) return 0;
  const returns = sorted.slice(1).map((point, index) => {
    const previous = sorted[index];
    return previous.value === 0 ? 0 : (point.value - previous.value) / previous.value;
  });
  const average = sumBy(returns, (value) => value) / returns.length;
  const variance = sumBy(returns, (value) => (value - average) ** 2) / returns.length;
  return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, 2);
}

export function calculateSectorExposure(holdings: Array<{ sector: string; marketValue?: number; weight?: number }>): Exposure[] {
  const weighted = holdings.map((holding) => ({
    name: holding.sector,
    weight: holding.marketValue ?? holding.weight ?? 0,
  }));
  const total = sumBy(weighted, (item) => item.weight);
  if (total === 0) return [];
  return groupWeight(weighted).map((item) => ({ name: item.name, weight: round((item.weight / total) * 100, 2) }));
}

export function normalizeTargetWeightPercent(weight: number): number {
  return weight <= 1 ? round(weight * 100, 2) : round(weight, 2);
}

export function summarizePortfolio(portfolio: Portfolio): PortfolioSummary {
  assertSameMarket(portfolio.marketId, portfolio.holdings);
  const enrichedHoldings = portfolio.holdings.map((holding) => {
    const marketValue = holding.quantity * holding.currentPrice;
    const cost = holding.quantity * holding.averageCost;
    return {
      ...holding,
      marketValue: round(marketValue, 2),
      cost: round(cost, 2),
      gain: round(marketValue - cost, 2),
      gainPercent: round(calculateReturn(cost, marketValue), 2),
      currentWeight: 0,
      targetGap: 0,
    };
  });
  const investedValue = sumBy(enrichedHoldings, (holding) => holding.marketValue);
  const rawTotalValue = investedValue + portfolio.cashBalance;
  const rawTotalCost = sumBy(enrichedHoldings, (holding) => holding.cost);
  const storedValueHistory = sanitizeStoredHistory(portfolio.valueHistory);
  const storedContributionHistory = sanitizeStoredHistory(portfolio.contributionHistory);
  const totalValue = storedValueHistory.at(-1)?.value ?? rawTotalValue;
  const totalCost = storedContributionHistory.at(-1)?.value ?? rawTotalCost;
  const holdings = enrichedHoldings.map((holding) => ({
    ...holding,
    currentWeight: totalValue === 0 ? 0 : round((holding.marketValue / totalValue) * 100, 2),
    targetGap: round(normalizeTargetWeightPercent(holding.targetWeight) - (totalValue === 0 ? 0 : (holding.marketValue / totalValue) * 100), 2),
  }));
  const valueHistory = storedValueHistory.length ? storedValueHistory : buildPortfolioValueHistory(portfolio, holdings);
  const drawdown = calculateDrawdown(valueHistory);
  const sectorExposure = calculateSectorExposure(holdings);
  const assetTypeExposure = calculateAssetTypeExposure(holdings, totalValue);
  const topHoldingConcentration = holdings.length ? Math.max(...holdings.map((holding) => holding.currentWeight)) : 0;
  const volatility = calculateVolatility(valueHistory);
  const riskScore = round(
    clamp(30 + topHoldingConcentration * 0.35 + (sectorExposure[0]?.weight ?? 0) * 0.25 + Math.abs(drawdown.maxDrawdown) * 0.8, 0, 100),
    1,
  );
  const first = valueHistory[0];
  const last = valueHistory.at(-1);

  return {
    totalValue: round(totalValue, 2),
    totalCost: round(totalCost, 2),
    totalGain: round(totalValue - totalCost, 2),
    totalGainPercent: round(calculateReturn(totalCost, totalValue), 2),
    annualizedReturn: first && last ? calculateAnnualizedReturn(first.value, last.value, first.date, last.date) : 0,
    cashBalance: portfolio.cashBalance,
    maxDrawdown: drawdown.maxDrawdown,
    volatility,
    sharpeRatio: volatility === 0 ? 0 : round(((first && last ? calculateReturn(first.value, last.value) : 0) - 3) / volatility, 2),
    riskScore,
    sectorExposure,
    assetTypeExposure,
    topHoldingConcentration: round(topHoldingConcentration, 2),
    holdings,
    valueHistory,
  };
}

export const calculatePortfolioSummary = summarizePortfolio;

function sanitizeStoredHistory(value: unknown): TimePoint[] {
  if (!Array.isArray(value)) return [];
  return sortHistory(
    value
      .filter((item): item is TimePoint => Boolean(item && typeof item === "object" && "date" in item && "value" in item))
      .map((item) => ({ date: String(item.date), value: round(Number(item.value) || 0, 2) }))
      .filter((item) => item.date && item.value >= 0),
  );
}

function buildPortfolioValueHistory(portfolio: Portfolio, holdings: Array<Holding & { marketValue: number }>): TimePoint[] {
  void portfolio;
  void holdings;
  return [];
}

function calculateAssetTypeExposure(holdings: Array<{ assetType: string; marketValue: number }>, totalValue: number): Exposure[] {
  if (totalValue === 0) return [];
  const grouped = new Map<string, number>();
  holdings.forEach((holding) => grouped.set(holding.assetType, (grouped.get(holding.assetType) ?? 0) + holding.marketValue));
  return Array.from(grouped.entries()).map(([name, value]) => ({ name, weight: round((value / totalValue) * 100, 2) }));
}

export function simulateDcaPlan(fund: Fund, input: DcaInput): DcaSimulation {
  const history = filterHistoryByDateRange(fund.navHistory, input.startDate, input.endDate);
  const contributionDates = buildContributionDates(input.startDate, input.endDate, input.frequency);
  let nextContributionIndex = 0;
  const dividendByDate = new Map((fund.dividends ?? []).map((dividend) => [dividend.date, dividend.amount]));
  const firstDate = history[0]?.date ?? input.startDate;
  let totalInvested = 0;
  let accumulatedShares = 0;
  let totalFees = 0;
  let totalDividends = 0;
  let cashDividends = 0;
  const cashFlowHistory: DcaCashFlow[] = [];
  const valueHistory: TimePoint[] = [];
  const contributionHistory: TimePoint[] = [];

  history.forEach((point, index) => {
    const isInitial = index === 0;
    let scheduledCount = 0;
    while (nextContributionIndex < contributionDates.length && contributionDates[nextContributionIndex] <= point.date) {
      if (contributionDates[nextContributionIndex] !== input.startDate) {
        scheduledCount += 1;
      }
      nextContributionIndex += 1;
    }
    let contribution = 0;
    let fee = 0;
    let sharesPurchased = 0;
    if (isInitial || scheduledCount > 0) {
      const baseContribution = (isInitial ? input.initialAmount : 0) + input.recurringAmount * scheduledCount;
      contribution = baseContribution * strategyContributionMultiplier(input, point, {
        accumulatedShares,
        firstDate,
        totalInvested,
        valueHistory,
      });
      const transactionCount = (isInitial && input.initialAmount > 0 ? 1 : 0) + scheduledCount;
      fee = Math.min(input.transactionCost * transactionCount, contribution);
      sharesPurchased = point.value === 0 ? 0 : (contribution - fee) / point.value;
      totalInvested += contribution;
      totalFees += fee;
      accumulatedShares += sharesPurchased;
    }

    let dividend = 0;
    let dividendShares = 0;
    if (point.value > 0 && accumulatedShares > 0) {
      const explicitDividendPerShare = dividendByDate.get(point.date);
      if (typeof explicitDividendPerShare === "number" && explicitDividendPerShare > 0) {
        dividend = accumulatedShares * explicitDividendPerShare;
      }
      if (dividend > 0) {
        totalDividends += dividend;
        if (shouldReinvestDividends(input)) {
          dividendShares = dividend / point.value;
          accumulatedShares += dividendShares;
        } else {
          cashDividends += dividend;
        }
        if (!contribution) {
          cashFlowHistory.push({
            date: point.date,
            nav: point.value,
            contribution: 0,
            fee: 0,
            dividend: round(dividend, 2),
            dividendShares: round(dividendShares, 6),
            sharesPurchased: 0,
            accumulatedShares: round(accumulatedShares, 6),
            portfolioValue: round(accumulatedShares * point.value + cashDividends, 2),
          });
        }
      }
    }

    if (contribution) {
      cashFlowHistory.push({
        date: point.date,
        nav: point.value,
        contribution: round(contribution, 2),
        fee: round(fee, 2),
        dividend: round(dividend, 2),
        dividendShares: round(dividendShares, 6),
        sharesPurchased: round(sharesPurchased, 6),
        accumulatedShares: round(accumulatedShares, 6),
        portfolioValue: round(accumulatedShares * point.value + cashDividends, 2),
      });
    }

    valueHistory.push({ date: point.date, value: round(accumulatedShares * point.value + cashDividends, 2) });
    contributionHistory.push({ date: point.date, value: round(totalInvested, 2) });
  });

  const finalValue = valueHistory.at(-1)?.value ?? 0;
  const drawdown = calculateDrawdown(valueHistory);
  const lastDate = history.at(-1)?.date ?? input.endDate;

  return {
    id: `${fund.id}-dca-simulation`,
    marketId: fund.marketId,
    fundId: fund.id,
    name: input.name ?? `${fund.name} DCA`,
    input,
    totalInvested: round(totalInvested, 2),
    totalFees: round(totalFees, 2),
    totalDividends: round(totalDividends, 2),
    finalValue: round(finalValue, 2),
    totalReturn: round(finalValue - totalInvested, 2),
    totalReturnPercent: round(calculateReturn(totalInvested, finalValue), 2),
    annualizedReturn: calculateDcaAnnualizedReturn(cashFlowHistory, finalValue, lastDate),
    maxDrawdown: drawdown.maxDrawdown,
    averageCost: accumulatedShares === 0 ? 0 : round((totalInvested - totalFees) / accumulatedShares, 4),
    sharesAccumulated: round(accumulatedShares, 6),
    valueHistory,
    contributionHistory,
    drawdownHistory: drawdown.drawdownHistory,
    cashFlowHistory,
    annualReturns: calculatePeriodReturns(valueHistory, 4).map((point) => ({ year: point.date, return: point.value })),
    monthlyReturns: calculatePeriodReturns(valueHistory, 7).map((point) => ({ month: point.date, return: point.value })),
  };
}

function calculateDcaAnnualizedReturn(cashFlowHistory: DcaCashFlow[], finalValue: number, finalDate: string): number {
  const cashFlows = cashFlowHistory
    .filter((row) => row.contribution > 0)
    .map((row) => ({ date: row.date, amount: -row.contribution }));
  if (finalValue > 0) {
    cashFlows.push({ date: finalDate, amount: finalValue });
  }
  return calculateXirr(cashFlows);
}

function calculateXirr(cashFlows: Array<{ date: string; amount: number }>): number {
  const datedFlows = cashFlows
    .filter((flow) => flow.amount !== 0)
    .map((flow) => ({ date: new Date(`${flow.date}T00:00:00Z`), amount: flow.amount }));
  if (!datedFlows.some((flow) => flow.amount > 0) || !datedFlows.some((flow) => flow.amount < 0)) return 0;

  const firstTime = Math.min(...datedFlows.map((flow) => flow.date.getTime()));
  const npv = (rate: number) =>
    sumBy(datedFlows, (flow) => flow.amount / ((1 + rate) ** ((flow.date.getTime() - firstTime) / 86_400_000 / 365.25)));

  let low = -0.9999;
  let high = 10;
  let lowValue = npv(low);
  let highValue = npv(high);

  while (lowValue * highValue > 0 && high < 1000) {
    high *= 2;
    highValue = npv(high);
  }
  if (lowValue * highValue > 0) return 0;

  for (let index = 0; index < 100; index += 1) {
    const mid = (low + high) / 2;
    const midValue = npv(mid);
    if (Math.abs(midValue) < 0.000001) return round(mid * 100, 2);
    if (lowValue * midValue <= 0) {
      high = mid;
      highValue = midValue;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }

  return round(((low + high) / 2) * 100, 2);
}

function shouldReinvestDividends(input: DcaInput): boolean {
  return input.reinvestDividends || input.strategy === "dividend-reinvest" || input.strategy === "custom";
}

function strategyContributionMultiplier(
  input: DcaInput,
  point: TimePoint,
  state: {
    accumulatedShares: number;
    firstDate: string;
    totalInvested: number;
    valueHistory: TimePoint[];
  },
): number {
  const currentValue = state.accumulatedShares * point.value;
  const previousValue = state.valueHistory.at(-1)?.value ?? currentValue;
  let multiplier = 1;

  if ((input.strategy === "drawdown-addon" || input.strategy === "custom") && previousValue > currentValue) {
    multiplier += 0.25;
  }

  if ((input.strategy === "target-return" || input.strategy === "custom") && state.totalInvested > 0) {
    const years = Math.max(0, daysBetween(state.firstDate, point.date) / 365.25);
    const targetValue = state.totalInvested * ((1 + TARGET_RETURN_ANNUAL_RATE) ** years);
    if (currentValue < targetValue) {
      multiplier += input.strategy === "custom" ? 0.15 : 0.2;
    }
  }

  return multiplier;
}

export function simulateDCA(input: DcaInput & { fund?: Fund }): DcaSimulation {
  if (!input.fund) {
    throw new Error(`simulateDCA requires a fund object for ${input.fundId}`);
  }
  return simulateDcaPlan(input.fund, input);
}

function calculatePeriodReturns(history: TimePoint[], keyLength: number): TimePoint[] {
  const buckets = new Map<string, TimePoint[]>();
  sortHistory(history).forEach((point) => {
    const key = point.date.slice(0, keyLength);
    buckets.set(key, [...(buckets.get(key) ?? []), point]);
  });
  return Array.from(buckets.entries()).map(([date, points]) => ({
    date,
    value: round(calculateReturn(points[0].value, points.at(-1)!.value), 2),
  }));
}

export function scoreCustomFund(
  marketId: MarketId,
  holdings: CustomFundHolding[],
  stockUniverse: Stock[],
): CustomFundScore {
  const selected = holdings
    .map((holding) => ({ holding, stock: stockUniverse.find((stock) => stock.id === holding.stockId) }))
    .filter((item): item is { holding: CustomFundHolding; stock: Stock } => Boolean(item.stock))
    .filter((item) => item.stock.marketId === marketId);
  const totalWeight = sumBy(holdings, (holding) => holding.weight);
  const normalized = normalizeWeights(selected.map(({ holding, stock }) => ({ name: stock.sector, weight: holding.weight })));
  const sectorExposure = groupWeight(normalized).map((item) => ({
    name: item.name,
    sector: item.name,
    weight: round(item.weight * 100, 2),
  })) as CustomFundScore["sectorExposure"];
  const topWeight = holdings.length ? Math.max(...holdings.map((holding) => holding.weight)) : 0;
  const backtestHistory = buildCustomFundBacktest(selected);
  const drawdown = calculateDrawdown(backtestHistory);

  return {
    totalWeight: round(totalWeight, 2),
    peRatio: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.peRatio), weight: holding.weight }))), 2),
    pbRatio: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.pbRatio), weight: holding.weight }))), 2),
    dividendYield: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.dividendYield), weight: holding.weight }))), 2),
    roe: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.roe), weight: holding.weight }))), 2),
    volatility: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.volatility), weight: holding.weight }))), 2),
    valueScore: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.valueScore), weight: holding.weight }))), 1),
    qualityScore: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.qualityScore), weight: holding.weight }))), 1),
    dividendScore: round(
      weightedAverage(selected.map(({ holding, stock }) => ({ value: clamp(finiteMetric(stock.dividendYield) * 18, 0, 100), weight: holding.weight }))),
      1,
    ),
    riskScore: round(weightedAverage(selected.map(({ holding, stock }) => ({ value: finiteMetric(stock.riskScore), weight: holding.weight }))), 1),
    concentrationScore: round(clamp(100 - topWeight, 0, 100), 1),
    sectorExposure,
    backtestHistory,
    maxDrawdown: drawdown.maxDrawdown,
  };
}

function finiteMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildCustomFundBacktest(selected: Array<{ holding: CustomFundHolding; stock: Stock }>): TimePoint[] {
  const histories = selected.map(({ stock }) => priceHistoryByDate(stock));
  if (!histories.length || histories.some((history) => history.size === 0)) return [];

  const [firstHistory, ...restHistories] = histories;
  const commonDates = Array.from(firstHistory.keys())
    .filter((date) => restHistories.every((history) => history.has(date)))
    .sort((left, right) => left.localeCompare(right));
  if (!commonDates.length) return [];

  const bases = histories.map((history) => history.get(commonDates[0]) ?? 0);
  return commonDates.map((date) => {
    const value = selected.reduce((total, { holding }, index) => {
      const base = bases[index] ?? 0;
      const current = histories[index].get(date) ?? 0;
      return total + (holding.weight / 100) * 100 * (base === 0 ? 1 : current / base);
    }, 0);
    return { date, value: round(value, 2) };
  });
}

function priceHistoryByDate(stock: Stock): Map<string, number> {
  const history = new Map<string, number>();
  for (const point of stock.priceHistory ?? []) {
    if (!point.date || !Number.isFinite(point.value)) continue;
    history.set(point.date, point.value);
  }
  return history;
}

export function generatePortfolioInsights(portfolio: Portfolio, funds: Fund[], stocks: Stock[]): Insight[] {
  const summary = summarizePortfolio(portfolio);
  const insights: Insight[] = [];
  const topSector = summary.sectorExposure[0];
  const defensiveSectors = DEFENSIVE_SECTORS[portfolio.marketId];
  const cyclicalSectors = CYCLICAL_SECTORS[portfolio.marketId];
  const defensiveWeight = sumBy(summary.sectorExposure.filter((item) => defensiveSectors.includes(item.name)), (item) => item.weight);
  const cyclicalWeight = sumBy(summary.sectorExposure.filter((item) => cyclicalSectors.includes(item.name)), (item) => item.weight);

  if (topSector && topSector.weight > 35) {
    insights.push(makeInsight(portfolio, "concentration", "Sector concentration is elevated", `${topSector.name} is ${topSector.weight}% of the portfolio.`, "A sector above 35% can dominate drawdowns.", `Move new contributions toward ${defensiveSectors.slice(0, 2).join(", ")}.`, 28, summary, funds, stocks));
  }

  if (summary.topHoldingConcentration > 25) {
    insights.push(makeInsight(portfolio, "rebalance", "Top holding needs a lighter role", `Largest holding is ${summary.topHoldingConcentration}% of total value.`, "Single-position weight above 25% changes the intended risk profile.", "Use contributions or partial trimming to move it toward target.", 18, summary, funds, stocks));
  }

  if (defensiveWeight < 18) {
    insights.push(makeInsight(portfolio, "defensive", "Defensive ballast is light", `Defensive sectors are ${round(defensiveWeight, 1)}% of the portfolio.`, "Dividend, healthcare, staples, and utilities can soften market stress.", "Build a 20% defensive sleeve before adding more cyclical exposure.", 20, summary, funds, stocks));
  }

  if (cyclicalWeight > 45) {
    insights.push(makeInsight(portfolio, "valuation", "Cyclical exposure may amplify volatility", `Cyclical sectors are ${round(cyclicalWeight, 1)}% of total value.`, "Cyclicals often move together around macro surprises.", "Pair cyclical value with low-volatility or dividend funds.", 38, summary, funds, stocks));
  }

  if (insights.length === 0) {
    insights.push(makeInsight(portfolio, "income", "Portfolio balance looks healthy", "No major concentration or defensive gaps were detected.", "Risk, sector, and target-weight checks are within FundX thresholds.", "Keep DCA active and review drift monthly.", 100, summary, funds, stocks));
  }

  return insights.map((insight, index) => ({ ...insight, id: `${insight.id}-${index + 1}` }));
}

export const generateInsights = generatePortfolioInsights;

function makeInsight(
  portfolio: Portfolio,
  type: Insight["type"],
  title: string,
  issue: string,
  reason: string,
  suggestion: string,
  targetWeight: number,
  summary: PortfolioSummary,
  funds: Fund[],
  stocks: Stock[],
): Insight {
  const candidateAssets = [
    ...funds.filter((fund) => fund.marketId === portfolio.marketId).slice(0, 2).map((fund) => fund.symbol),
    ...stocks.filter((stock) => stock.marketId === portfolio.marketId).slice(0, 1).map((stock) => stock.symbol),
  ];
  return {
    id: `insight-${portfolio.marketId}-${portfolio.id}`,
    marketId: portfolio.marketId,
    portfolioId: portfolio.id,
    type,
    title,
    issue,
    reason,
    suggestion,
    targetWeight,
    candidateAssets,
    estimatedImpact: `Risk score ${summary.riskScore} -> ${round(clamp(summary.riskScore - 5, 0, 100), 1)}; max drawdown ${summary.maxDrawdown}% -> ${round(Math.min(0, summary.maxDrawdown + 2), 2)}%.`,
    beforeMetrics: {
      riskScore: summary.riskScore,
      maxDrawdown: summary.maxDrawdown,
      volatility: summary.volatility,
      topHoldingWeight: summary.topHoldingConcentration,
    },
    afterMetrics: {
      riskScore: round(clamp(summary.riskScore - 5, 0, 100), 1),
      maxDrawdown: round(Math.min(0, summary.maxDrawdown + 2), 2),
      volatility: round(Math.max(0, summary.volatility - 1.5), 2),
      topHoldingWeight: round(Math.max(0, summary.topHoldingConcentration - 4), 2),
    },
    createdAt: "2026-06-03",
  };
}
