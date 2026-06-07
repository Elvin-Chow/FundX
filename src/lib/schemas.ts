import { z } from "zod";

export const marketIdSchema = z.literal("us");

export const assetTypeSchema = z.enum(["fund", "stock", "etf", "customFund", "customAsset"]);

const importRecordSchema = z.record(z.unknown());

export const dcaFrequencySchema = z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);

export const dcaStrategySchema = z.enum(["standard", "drawdown-addon", "dividend-reinvest", "target-return", "custom"]);

export const watchlistMutationSchema = z.object({
  marketId: marketIdSchema,
  assetId: z.string().min(1),
  assetType: assetTypeSchema,
  note: z.string().max(240).optional(),
  target: z.coerce.number().positive().optional()
});

export const dcaPlanSaveSchema = z.object({
  marketId: marketIdSchema,
  fundId: z.string().min(1),
  name: z.string().min(1).max(80),
  initialAmount: z.coerce.number().nonnegative(),
  recurringAmount: z.coerce.number().positive(),
  frequency: dcaFrequencySchema,
  startDate: z.string().max(10),
  endDate: z.string().max(10),
  reinvestDividends: z.coerce.boolean(),
  transactionCost: z.coerce.number().nonnegative(),
  strategy: dcaStrategySchema
});

export const customFundSaveSchema = z.object({
  marketId: marketIdSchema,
  name: z.string().min(1).max(80),
  style: z.string().min(1).max(60),
  holdings: z.array(
    z.object({
      stockId: z.string().min(1),
      weight: z.coerce.number().min(0).max(100),
      locked: z.boolean().optional()
    })
  ).min(1)
});

export const portfolioSnapshotSchema = z.object({
  marketId: marketIdSchema,
  portfolioId: z.string().min(1),
  note: z.string().max(280).optional()
});

export const reportGenerateSchema = z.object({
  marketId: marketIdSchema,
  type: z.enum(["portfolio", "dca", "custom-fund"]).default("portfolio"),
  params: z.record(z.unknown()).optional(),
});

export const holdingMutationSchema = z.object({
  marketId: marketIdSchema,
  portfolioId: z.string().min(1),
  assetId: z.string().min(1),
  assetType: assetTypeSchema,
  quantity: z.coerce.number().nonnegative(),
  averageCost: z.coerce.number().nonnegative(),
  targetWeight: z.coerce.number().min(0).max(100),
});

export const transactionMutationSchema = z.object({
  marketId: marketIdSchema,
  portfolioId: z.string().min(1),
  assetId: z.string().min(1),
  assetType: assetTypeSchema,
  side: z.enum(["buy", "sell"]),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().positive(),
  fee: z.coerce.number().nonnegative().default(0),
  tradeDate: z.string().min(10).max(10),
  note: z.string().max(240).optional(),
});

export const cashMovementMutationSchema = z.object({
  marketId: marketIdSchema,
  portfolioId: z.string().min(1),
  type: z.enum(["deposit", "withdrawal", "dividend", "fee", "interest", "adjustment"]),
  amount: z.coerce.number(),
  date: z.string().min(10).max(10),
  assetId: z.string().optional(),
  note: z.string().max(240).optional(),
});

export const settingsImportModeSchema = z.enum(["merge", "replace"]).default("merge");

export const settingsExportPayloadSchema = z.object({
  marketId: marketIdSchema,
  generatedAt: z.string().min(1).default(() => new Date().toISOString()),
  portfolios: z.array(importRecordSchema).default([]),
  activePortfolio: importRecordSchema.optional(),
  portfolioSummary: importRecordSchema.optional(),
  customFunds: z.array(importRecordSchema).default([]),
  dcaPlans: z.array(importRecordSchema).default([]),
  watchlist: z.array(importRecordSchema).default([]),
  reports: z.array(importRecordSchema).default([]),
  preferences: z.array(z.object({
    label: z.string().min(1),
    value: z.string(),
    description: z.string().default(""),
  })).optional(),
});
