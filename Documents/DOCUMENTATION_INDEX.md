# iLoad Forecasting Utility - Documentation Index

This index provides an overview of all documentation for the iLoad Forecasting Utility.

---

## Getting Started

| Document | Description |
|----------|-------------|
| [QUICK_START.md](QUICK_START.md) | 5-minute guide to running your first forecast |
| [GUI_GUIDE.md](GUI_GUIDE.md) | Desktop GUI user manual with CLI command mappings |
| [CLI_GUIDE.md](CLI_GUIDE.md) | Complete CLI reference for all commands |

---

## Core Documentation

| Document | Description |
|----------|-------------|
| [USER_GUIDE.md](USER_GUIDE.md) | Comprehensive workflows, examples, and best practices |
| [MODEL_OVERVIEW.md](MODEL_OVERVIEW.md) | Forecasting model descriptions and performance metrics |
| [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) | Architecture, data flow, and implementation details |

---

## Reference

| Document | Description |
|----------|-------------|
| [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) | Guide for AI assistants working with this codebase |
| [../CLAUDE.md](../CLAUDE.md) | Project instructions and quick reference for Claude Code |

---

## Specialized Topics

### Interconnector Analysis
| Document | Description |
|----------|-------------|
| [interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md](interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md) | Final report on interconnector constraint prediction |
| [interconnector_analysis/MODEL_COMPARISON_REPORT.md](interconnector_analysis/MODEL_COMPARISON_REPORT.md) | Comparison of interconnector prediction models |
| [interconnector_analysis/VISLUZ1_EXECUTIVE_SUMMARY.md](interconnector_analysis/VISLUZ1_EXECUTIVE_SUMMARY.md) | VISLUZ1 interconnector analysis summary |

### Planning Documents
| Document | Description |
|----------|-------------|
| [planning/context.md](planning/context.md) | Current development context and progress |
| [planning/MREC_ML_HYBRID_DESIGN.md](planning/MREC_ML_HYBRID_DESIGN.md) | MREC + ML hybrid model design |
| [planning/IPOOL_WIND_MREC_ANALYSIS.md](planning/IPOOL_WIND_MREC_ANALYSIS.md) | Wind MREC algorithm analysis |

---

## Document Purposes by Use Case

### "I want to run a forecast quickly"
1. [QUICK_START.md](QUICK_START.md) - Minimal setup instructions
2. [GUI_GUIDE.md](GUI_GUIDE.md) - Use the desktop GUI (easiest)

### "I need to understand CLI commands"
1. [CLI_GUIDE.md](CLI_GUIDE.md) - Complete command reference
2. [GUI_GUIDE.md](GUI_GUIDE.md) - See "CLI Command Mapping" section

### "I want to understand the forecasting models"
1. [MODEL_OVERVIEW.md](MODEL_OVERVIEW.md) - Model descriptions and performance
2. [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) - Implementation details

### "I need to integrate this with other systems"
1. [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) - Architecture and data formats
2. [CLI_GUIDE.md](CLI_GUIDE.md) - Command-line automation

### "I'm developing or maintaining this codebase"
1. [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) - Code structure and conventions
2. [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) - Architecture deep-dive
3. [../CLAUDE.md](../CLAUDE.md) - Quick reference for common operations

---

## GUI vs CLI Quick Reference

| Task | GUI | CLI |
|------|-----|-----|
| Demand forecast (regional) | Enable Demand, disable Zonal | `forecast -d <path> -s <date> -e <date> -o <file>` |
| Demand forecast (zonal) | Enable Demand + Zonal | `forecast -d <path> --zonal -s <date> -e <date> -o <file>` |
| Capacity factor forecast | Enable CFAC | `cfac forecast2 -t <path> -s <date> -e <date> -o <file>` |
| View database info | Select database, view info panel | `db status --db <path>` |
| Import to database | Update Database → select type | `db import -t <type> -f <path> --db <path>` |

---

## Key Concepts

### Data Modes

| Mode | Database | CSV |
|------|----------|-----|
| **Regional** | `iload.db` with 3 regions (CLUZ, CVIS, CMIN) | CSVs with regional columns |
| **Zonal** | `iload_zonal.db` with 14 zones | CSVs with zone columns (01NLUZ, 02METRO, etc.) |

### Forecast Types

| Type | Purpose | Model |
|------|---------|-------|
| **Demand** | Electricity load prediction | Hybrid (XGBoost + statistical profiles) |
| **CFAC** | Capacity factor for renewables | Wind: 4-Tier Hybrid, Solar: Physics+ML |

### Output Files

| Type | Default Prefix | Example |
|------|----------------|---------|
| Regional demand | `FC_DEM_` | `FC_DEM_2025-12-01_2025-12-31.csv` |
| Zonal demand | `FC_ZDEM_` | `FC_ZDEM_2025-12-01_2025-12-31.csv` |
| Capacity factor | `FC_CF_` | `FC_CF_2025-12-01_2025-12-31.csv` |

---

## Version Information

- **CLI Version**: 1.0.0
- **GUI Version**: 2.0.0
- **Last Updated**: February 2026
