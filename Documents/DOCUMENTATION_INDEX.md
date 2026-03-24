---
Status: Active
Last-Updated: 2026-03-24
Updated-By: Claude Code
---

# Vantage Forecaster - Documentation Index

**For AI Agents:** Start with `../CLAUDE.md` for quick reference, then use this index.

---

## Quick Navigation

| I want to... | Start here |
|--------------|------------|
| Run my first forecast | [QUICK_START.md](QUICK_START.md) |
| Use the desktop GUI | [GUI_GUIDE.md](GUI_GUIDE.md) |
| Use CLI commands | [CLI_GUIDE.md](CLI_GUIDE.md) or [../CLAUDE.md](../CLAUDE.md) |
| Understand GUI-to-CLI mapping | [GUI_CLI_INTEGRATION.md](GUI_CLI_INTEGRATION.md) |
| Deploy to users | [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) |
| Understand the models | [MODEL_OVERVIEW.md](MODEL_OVERVIEW.md) |
| Review demand methodology | [DEMAND_FORECASTING_METHODOLOGY.md](DEMAND_FORECASTING_METHODOLOGY.md) |
| Review CFAC methodology | [CFAC_FORECASTING_METHODOLOGY.md](CFAC_FORECASTING_METHODOLOGY.md) |
| Work on the codebase | [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) |

---

## All Documents

| Document | Description |
|----------|-------------|
| [QUICK_START.md](QUICK_START.md) | 5-minute getting started guide |
| [CLI_GUIDE.md](CLI_GUIDE.md) | Complete CLI command reference |
| [GUI_GUIDE.md](GUI_GUIDE.md) | Desktop GUI user manual |
| [GUI_CLI_INTEGRATION.md](GUI_CLI_INTEGRATION.md) | **GUI architecture** - How GUI invokes CLI commands |
| [MODEL_OVERVIEW.md](MODEL_OVERVIEW.md) | Forecasting models and performance |
| [DEMAND_FORECASTING_METHODOLOGY.md](DEMAND_FORECASTING_METHODOLOGY.md) | **Detailed demand methodology** - Technical review document |
| [CFAC_FORECASTING_METHODOLOGY.md](CFAC_FORECASTING_METHODOLOGY.md) | **Detailed CFAC methodology** - Wind, solar, hydro forecasting |
| [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) | Architecture and code structure |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Building portable Windows distributions |
| [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) | Onboarding guide for AI agents |
| [GATEWAY_FILE_SPECIFICATION.md](GATEWAY_FILE_SPECIFICATION.md) | Gateway file format and naming |
| [FORECAST_FILE_API_SPEC.md](FORECAST_FILE_API_SPEC.md) | Forecast file API specification |
| [../CLAUDE.md](../CLAUDE.md) | **Primary reference** - Commands, models, architecture |

---

## Key Concepts

### Forecast Types

| Type | Model | Typical Accuracy |
|------|-------|------------------|
| Demand | Hybrid (XGBoost + profiles) | 2-4% MAPE |
| Wind CFAC | 4-Tier Hybrid | ~73% MAPE |
| Solar CFAC | Physics+ML | ~16% MAPE |

### Data Modes

| Mode | Regions | Database |
|------|---------|----------|
| Regional | 3 (CLUZ, CVIS, CMIN) | `iload.db` |
| Zonal | 14 sub-regions | `iload_zonal.db` |

---

## Common Commands

```bash
# Demand forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv

# Capacity factor forecast
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv

# Scheduler
node dist/index.js scheduler run

# Build portable distribution
node scripts/build-portable.cjs --zip --clean
```

---

**Last Updated:** March 2026
