"""Non-ML portfolio risk model adapted from Risk_Analysis_System.

The implementation intentionally uses the traditional RiskEngine and
BayesianOptimizer ideas from ../Risk_Analysis_System:
- log-return risk samples
- Ledoit-Wolf covariance shrinkage
- long-only mean-variance optimization
- Historical and Monte Carlo Expected Shortfall

It does not import or run the ML, XGBoost, regime, or anomaly modules.
"""

from __future__ import annotations

from typing import Any

MODEL_SOURCE = "Risk_Analysis_System / DeepFirm Quant"
MODEL_VERSION = "risk-engine-ledoit-wolf-mean-variance-v1"
MIN_DISPLAY_WEIGHT_PCT = 0.1


def optimize_insight_candidates(
    candidates: list[dict[str, Any]],
    objective_id: str,
    risk_profile: str,
    max_position_pct: float,
    target_count: int,
    min_history_points: int = 20,
) -> dict[str, Any] | None:
    """Optimize history-backed candidates with the DeepFirm Quant risk model."""
    try:
        import numpy as np
        import pandas as pd
    except Exception as exc:
        return _skip(f"Risk model dependencies are unavailable: {exc}")

    price_df, ordered = _price_frame(candidates, min_history_points)
    if price_df is None or len(ordered) < 3:
        return _skip("Fewer than three candidates had overlapping price history for risk-model optimization.")

    try:
        returns_df = RiskModel.compute_log_returns(price_df)
        returns_df = RiskModel.sanitize_returns(returns_df)
        prior_returns, cov_matrix = RiskModel.prepare_optimization_inputs(returns_df, len(ordered))
        expected_returns = _objective_expected_returns(prior_returns, ordered, objective_id)
        first_pass = BayesianOptimizer.optimize_weights(
            expected_returns,
            cov_matrix,
            risk_aversion=_risk_aversion(objective_id, risk_profile),
            max_weight=max_position_pct / 100,
            min_weight=0.0,
            turnover_penalty=0.01,
            concentration_penalty=_concentration_penalty(objective_id, risk_profile),
        )
        top_indexes = _top_weight_indexes(first_pass, target_count)
        top_price_df = price_df.iloc[:, top_indexes]
        top_candidates = [ordered[index] for index in top_indexes]
        top_returns = RiskModel.sanitize_returns(RiskModel.compute_log_returns(top_price_df))
        top_prior_returns, top_cov = RiskModel.prepare_optimization_inputs(top_returns, len(top_candidates))
        top_expected = _objective_expected_returns(top_prior_returns, top_candidates, objective_id)
        top_prior_weights = first_pass[top_indexes]
        top_prior_weights = top_prior_weights / max(float(top_prior_weights.sum()), 1e-12)
        final_weights = BayesianOptimizer.optimize_weights(
            top_expected,
            top_cov,
            prior_weights=top_prior_weights,
            risk_aversion=_risk_aversion(objective_id, risk_profile),
            max_weight=max_position_pct / 100,
            min_weight=0.0,
            turnover_penalty=0.02,
            concentration_penalty=_concentration_penalty(objective_id, risk_profile),
        )
        material_indexes = _material_weight_indexes(final_weights, min_weight_pct=MIN_DISPLAY_WEIGHT_PCT, min_assets=3)
        if len(material_indexes) < len(top_candidates):
            top_price_df = top_price_df.iloc[:, material_indexes]
            top_candidates = [top_candidates[index] for index in material_indexes]
            final_weights = final_weights[material_indexes]
            final_weights = final_weights / max(float(final_weights.sum()), 1e-12)
            top_returns = RiskModel.sanitize_returns(RiskModel.compute_log_returns(top_price_df))
        performance = RiskModel.compute_performance_metrics(top_returns, final_weights)
        historical_es = RiskModel.historical_es(top_returns, final_weights)
        monte_carlo_es = RiskModel.monte_carlo_es(top_returns, final_weights, n_simulations=5000)
        average_correlation = RiskModel.average_pairwise_correlation(top_returns)
        return_start_date, return_end_date = _return_date_range(top_returns)
    except Exception as exc:
        return _skip(f"Risk model optimization failed: {exc}")

    weights = {
        str(candidate.get("id")): round(float(final_weights[index]) * 100, 2)
        for index, candidate in enumerate(top_candidates)
    }
    return {
        "status": "applied",
        "source": MODEL_SOURCE,
        "version": MODEL_VERSION,
        "assets": top_candidates,
        "weights": weights,
        "metrics": {
            "expectedReturn": round(float(performance["annualized_return"]) * 100, 2),
            "volatility": round(float(performance["annualized_volatility"]) * 100, 2),
            "maxDrawdown": round(float(performance["max_drawdown"]) * 100, 2),
            "historicalES": round(float(historical_es) * 100, 2),
            "monteCarloES": round(float(monte_carlo_es) * 100, 2),
            "sharpeRatio": round(float(performance["sharpe_ratio"]), 2),
            "averageCorrelation": round(float(average_correlation), 3),
            "historyObservations": int(len(top_returns)),
            "returnStartDate": return_start_date,
            "returnEndDate": return_end_date,
        },
        "optimizationUniverseCount": len(ordered),
    }


class RiskModel:
    """Small non-ML subset of Risk_Analysis_System.models.risk_engine.RiskEngine."""

    @staticmethod
    def compute_log_returns(price_df: Any) -> Any:
        import numpy as np

        log_returns = np.log(price_df / price_df.shift(1))
        return log_returns.dropna()

    @staticmethod
    def sanitize_returns(returns_df: Any) -> Any:
        import numpy as np

        if returns_df.empty:
            raise ValueError("returns data is empty")
        cleaned = returns_df.replace([np.inf, -np.inf], np.nan).dropna(how="any")
        if cleaned.empty:
            raise ValueError("returns data contains no complete finite rows")
        return cleaned

    @staticmethod
    def _ensure_psd(cov: Any) -> Any:
        import numpy as np

        cov = np.asarray(cov, dtype=float)
        if cov.ndim != 2 or cov.shape[0] != cov.shape[1]:
            raise ValueError("covariance matrix must be square")
        if not np.isfinite(cov).all():
            raise ValueError("covariance matrix contains non-finite values")
        cov = (cov + cov.T) / 2.0
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        eigenvalues = np.maximum(eigenvalues, 1e-8)
        psd = eigenvectors @ np.diag(eigenvalues) @ eigenvectors.T
        return (psd + psd.T) / 2.0

    @staticmethod
    def prepare_optimization_inputs(returns_df: Any, n_assets: int) -> tuple[Any, Any]:
        import numpy as np
        from sklearn.covariance import LedoitWolf

        returns_df = RiskModel.sanitize_returns(returns_df)
        if len(returns_df) < 2:
            raise ValueError("at least two return observations are required")
        if returns_df.shape[1] != n_assets:
            raise ValueError("returns data asset count does not match candidates")
        trading_days = 252.0
        mean_vector = np.nan_to_num(returns_df.mean().to_numpy(dtype=float)) * trading_days
        cov_matrix = np.nan_to_num(LedoitWolf().fit(returns_df.to_numpy(dtype=float)).covariance_) * trading_days
        return mean_vector, RiskModel._ensure_psd(cov_matrix)

    @staticmethod
    def historical_es(returns_df: Any, weights: Any, confidence_level: float = 0.99) -> float:
        import numpy as np

        returns_df = RiskModel.sanitize_returns(returns_df)
        portfolio_returns = returns_df.to_numpy() @ weights
        portfolio_returns = portfolio_returns[np.isfinite(portfolio_returns)]
        if portfolio_returns.size == 0:
            raise ValueError("portfolio returns contain no finite values")
        var_threshold = np.percentile(portfolio_returns, (1.0 - confidence_level) * 100.0)
        tail_returns = portfolio_returns[portfolio_returns <= var_threshold]
        return float(tail_returns.mean()) if tail_returns.size else float(var_threshold)

    @staticmethod
    def monte_carlo_es(
        returns_df: Any,
        weights: Any,
        confidence_level: float = 0.99,
        n_simulations: int = 10_000,
        random_seed: int = 42,
    ) -> float:
        import numpy as np

        returns_df = RiskModel.sanitize_returns(returns_df)
        portfolio_returns = returns_df.to_numpy() @ weights
        mean = float(np.mean(portfolio_returns))
        std = float(np.std(portfolio_returns))
        rng = np.random.default_rng(random_seed)
        simulated = np.full(n_simulations, mean) if std <= 1e-12 else rng.normal(mean, std, n_simulations)
        var_threshold = np.percentile(simulated, (1.0 - confidence_level) * 100.0)
        tail_returns = simulated[simulated <= var_threshold]
        return float(tail_returns.mean()) if tail_returns.size else float(var_threshold)

    @staticmethod
    def compute_performance_metrics(returns_df: Any, weights: Any, risk_free_rate: float = 0.02) -> dict[str, float]:
        import numpy as np

        returns_df = RiskModel.sanitize_returns(returns_df)
        portfolio_returns = returns_df.to_numpy() @ weights
        cumulative = np.exp(np.cumsum(portfolio_returns))
        ann_vol = float(portfolio_returns.std() * np.sqrt(252))
        ann_return = float(np.exp(portfolio_returns.mean() * 252) - 1.0)
        sharpe = (ann_return - risk_free_rate) / ann_vol if ann_vol > 1e-12 else 0.0
        running_max = np.maximum.accumulate(cumulative)
        drawdown = (cumulative - running_max) / running_max
        return {
            "annualized_volatility": ann_vol,
            "annualized_return": ann_return,
            "sharpe_ratio": sharpe,
            "max_drawdown": float(drawdown.min()) if drawdown.size else 0.0,
        }

    @staticmethod
    def average_pairwise_correlation(returns_df: Any) -> float:
        import numpy as np

        if returns_df.shape[1] < 2:
            return 0.0
        corr = returns_df.corr().replace([np.inf, -np.inf], np.nan).to_numpy(dtype=float)
        upper = corr[np.triu_indices(corr.shape[0], k=1)]
        upper = upper[np.isfinite(upper)]
        return float(upper.mean()) if upper.size else 0.0


class BayesianOptimizer:
    """Small non-ML subset of Risk_Analysis_System.models.portfolio_opt.BayesianOptimizer."""

    @staticmethod
    def _effective_max_weight(max_weight: float, n_assets: int) -> float:
        if n_assets <= 0:
            raise ValueError("n_assets must be positive")
        return max(float(max_weight), 1.0 / n_assets)

    @staticmethod
    def _effective_min_weight(min_weight: float, n_assets: int) -> float:
        if n_assets <= 0:
            raise ValueError("n_assets must be positive")
        clean_min = max(float(min_weight), 0.0)
        return min(clean_min, 0.5 / n_assets)

    @staticmethod
    def _normalize_under_bounds(weights: Any, min_weight: float, max_weight: float) -> Any:
        import numpy as np

        weights = np.asarray(weights, dtype=float)
        n_assets = len(weights)
        effective_min = BayesianOptimizer._effective_min_weight(min_weight, n_assets)
        effective_max = BayesianOptimizer._effective_max_weight(max_weight, n_assets)
        remaining = 1.0 - effective_min * n_assets
        if remaining <= 1e-12:
            return np.ones(n_assets, dtype=float) / n_assets
        weights = np.clip(weights, 0.0, None)
        total = float(weights.sum())
        scaled = np.ones(n_assets, dtype=float) * (remaining / n_assets) if total <= 1e-12 else weights / total * remaining
        capped = np.zeros(n_assets, dtype=float)
        active = np.ones(n_assets, dtype=bool)
        residual = remaining
        shifted_capacity = effective_max - effective_min
        while active.any() and residual > 1e-12:
            active_indices = np.flatnonzero(active)
            active_scaled = scaled[active]
            active_sum = float(active_scaled.sum())
            allocation = (
                np.ones(len(active_indices), dtype=float) * (residual / len(active_indices))
                if active_sum <= 1e-12
                else residual * active_scaled / active_sum
            )
            overweight = allocation > shifted_capacity + 1e-12
            if not overweight.any():
                capped[active_indices] = allocation
                break
            overweight_indices = active_indices[overweight]
            capped[overweight_indices] = shifted_capacity
            residual -= shifted_capacity * len(overweight_indices)
            active[overweight_indices] = False
        bounded = np.clip(capped + effective_min, effective_min, effective_max)
        diff = 1.0 - float(bounded.sum())
        order = np.argsort(bounded if diff > 0 else -bounded)
        for idx in order:
            if abs(diff) <= 1e-10:
                break
            capacity = (effective_max - bounded[idx]) if diff > 0 else (bounded[idx] - effective_min)
            move = min(float(capacity), abs(diff))
            bounded[idx] += move if diff > 0 else -move
            diff += -move if diff > 0 else move
        if not np.isfinite(bounded).all() or abs(float(bounded.sum()) - 1.0) > 1e-8:
            raise RuntimeError("could not normalize weights under investment bounds")
        return bounded

    @staticmethod
    def optimize_weights(
        expected_returns: Any,
        cov_matrix: Any,
        prior_weights: Any | None = None,
        risk_aversion: float = 2.5,
        max_weight: float = 0.30,
        min_weight: float = 0.0,
        turnover_penalty: float = 0.02,
        concentration_penalty: float = 0.05,
    ) -> Any:
        import numpy as np
        from scipy.optimize import minimize

        mu = np.asarray(expected_returns, dtype=float)
        sigma = np.asarray(cov_matrix, dtype=float)
        n_assets = len(mu)
        if sigma.shape != (n_assets, n_assets):
            raise ValueError("covariance shape does not match expected returns")
        prior = None
        if prior_weights is not None:
            prior = np.asarray(prior_weights, dtype=float)
            if prior.shape != (n_assets,) or not np.isfinite(prior).all():
                prior = None

        def objective(weights: Any) -> float:
            base = -weights @ mu + (risk_aversion / 2.0) * weights @ sigma @ weights
            concentration = max(float(concentration_penalty), 0.0) * float(weights @ weights)
            turnover = 0.0
            if prior is not None:
                diff = weights - prior
                turnover = max(float(turnover_penalty), 0.0) * float(diff @ diff)
            return float(base + concentration + turnover)

        effective_min = BayesianOptimizer._effective_min_weight(min_weight, n_assets)
        effective_max = BayesianOptimizer._effective_max_weight(max_weight, n_assets)
        x0 = BayesianOptimizer._normalize_under_bounds(prior if prior is not None else np.ones(n_assets) / n_assets, effective_min, effective_max)
        result = minimize(
            objective,
            x0,
            method="SLSQP",
            bounds=[(effective_min, effective_max) for _ in range(n_assets)],
            constraints={"type": "eq", "fun": lambda weights: np.sum(weights) - 1.0},
            options={"ftol": 1e-9, "maxiter": 1000},
        )
        if not result.success:
            raise RuntimeError(f"optimization failed: {result.message}")
        return BayesianOptimizer._normalize_under_bounds(result.x, effective_min, effective_max)


def _price_frame(candidates: list[dict[str, Any]], min_history_points: int) -> tuple[Any | None, list[dict[str, Any]]]:
    import numpy as np
    import pandas as pd

    series_by_id: dict[str, Any] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        candidate_id = str(candidate.get("id") or "")
        history = candidate.get("history") if isinstance(candidate.get("history"), list) else []
        points = []
        for point in history:
            if not isinstance(point, dict):
                continue
            date_value = point.get("date")
            price_value = point.get("value")
            if not date_value or not isinstance(price_value, (int, float)) or price_value <= 0:
                continue
            points.append((pd.to_datetime(date_value, errors="coerce"), float(price_value)))
        points = [(date, value) for date, value in points if not pd.isna(date) and np.isfinite(value)]
        if len(points) < min_history_points:
            continue
        frame = pd.DataFrame(points, columns=["date", "value"]).dropna().drop_duplicates("date", keep="last").sort_values("date")
        if len(frame) < min_history_points:
            continue
        series_by_id[candidate_id] = pd.Series(frame["value"].to_numpy(dtype=float), index=pd.DatetimeIndex(frame["date"]).normalize())
        by_id[candidate_id] = candidate
    if len(series_by_id) < 3:
        return None, []
    price_df = pd.DataFrame(series_by_id).sort_index().ffill(limit=5).dropna(how="any")
    price_df = price_df.loc[:, price_df.nunique() > 1]
    if price_df.shape[0] < min_history_points or price_df.shape[1] < 3:
        return None, []
    return price_df, [by_id[str(column)] for column in price_df.columns]


def _return_date_range(returns_df: Any) -> tuple[str | None, str | None]:
    if getattr(returns_df, "empty", True):
        return None, None
    try:
        start = returns_df.index.min()
        end = returns_df.index.max()
        return start.date().isoformat(), end.date().isoformat()
    except Exception:
        return None, None


def _objective_expected_returns(prior_returns: Any, candidates: list[dict[str, Any]], objective_id: str) -> Any:
    import numpy as np

    adjusted = []
    for index, candidate in enumerate(candidates):
        metrics = candidate.get("metrics") or {}
        base = float(prior_returns[index])
        expected = _metric(metrics, "expectedReturn") / 100
        dividend = _metric(metrics, "dividendYield") / 100
        expense = _metric(metrics, "expenseRatio") / 100
        volatility = _metric(metrics, "volatility") / 100
        drawdown = abs(_metric(metrics, "maxDrawdown")) / 100
        quality = _metric(metrics, "qualityScore") / 100
        value = _metric(metrics, "valueScore") / 100
        blended = 0.58 * base + 0.42 * expected + quality * 0.015 + value * 0.008
        if objective_id == "defensive":
            blended += dividend * 0.18 - volatility * 0.40 - drawdown * 0.12
        elif objective_id == "growth":
            blended += max(expected, 0.0) * 0.30 + quality * 0.02
        elif objective_id == "income":
            blended += dividend * 0.55 - expense * 0.30 - volatility * 0.12
        else:
            blended += dividend * 0.12 - volatility * 0.16
        adjusted.append(blended)
    return np.asarray(adjusted, dtype=float)


def _risk_aversion(objective_id: str, risk_profile: str) -> float:
    by_objective = {"defensive": 5.4, "balanced": 3.1, "growth": 1.7, "income": 2.8}
    by_profile = {"conservative": 0.9, "balanced": 0.0, "growth": -0.35, "income": 0.15}
    return max(1.2, by_objective.get(objective_id, 3.1) + by_profile.get(risk_profile, 0.0))


def _concentration_penalty(objective_id: str, risk_profile: str) -> float:
    base = {"defensive": 0.16, "balanced": 0.10, "growth": 0.05, "income": 0.09}.get(objective_id, 0.10)
    if risk_profile == "conservative":
        base += 0.04
    if risk_profile == "growth":
        base -= 0.02
    return max(base, 0.02)


def _top_weight_indexes(weights: Any, target_count: int) -> Any:
    import numpy as np

    count = int(max(3, min(target_count, len(weights))))
    return np.argsort(-np.asarray(weights, dtype=float))[:count]


def _material_weight_indexes(weights: Any, min_weight_pct: float, min_assets: int) -> list[int]:
    import numpy as np

    weights_array = np.asarray(weights, dtype=float)
    min_weight = max(float(min_weight_pct), 0.0) / 100
    material = [int(index) for index, weight in enumerate(weights_array) if float(weight) >= min_weight]
    if len(material) >= min_assets:
        return material
    fallback_count = min(max(min_assets, len(material)), len(weights_array))
    return [int(index) for index in np.argsort(-weights_array)[:fallback_count]]


def _metric(metrics: dict[str, Any], key: str) -> float:
    value = metrics.get(key)
    return float(value) if isinstance(value, (int, float)) else 0.0


def _skip(reason: str) -> dict[str, Any]:
    return {
        "status": "skipped",
        "source": MODEL_SOURCE,
        "version": MODEL_VERSION,
        "reason": reason,
    }
