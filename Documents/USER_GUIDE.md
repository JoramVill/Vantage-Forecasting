# iLoad Forecasting Utility - User Guide

## Quick Start

### Prerequisites
- Node.js v20 or higher
- npm (Node Package Manager)
- Visual Crossing Weather API key (free tier available)

### Installation

1. **Clone/Download the project:**
   ```bash
   cd C:\Source_Codes\iLoad_Forecasting_Utility
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the application:**
   ```bash
   npm run build
   ```

4. **Set up API key:**
   ```bash
   # Windows
   set VISUAL_CROSSING_API_KEY=your_key_here

   # Linux/Mac
   export VISUAL_CROSSING_API_KEY=your_key_here

   # Or create config.json:
   echo {"visualCrossingApiKey":"your_key_here"} > config.json
   ```

5. **Verify installation:**
   ```bash
   iload --version
   ```

---

## Getting Started - Your First Forecast

### Step 1: Prepare Your Data

Place historical demand data in a folder:
```
Data Samples/Training Historical Demand Data/
  └─ demand_oct_nov_2024.csv
```

**Expected format:**
```csv
DateTimeEnding,Luzon,Visayas,Mindanao
11/1/2024 1:00,7500.5,1200.3,1450.2
11/1/2024 2:00,7200.1,1150.8,1400.5
```

### Step 2: Import Data to Database

```bash
iload db import \
  -t demand \
  -f "Data Samples/Training Historical Demand Data/"
```

### Step 3: Check Database Status

```bash
iload db status
```

You should see your imported records with date ranges.

### Step 4: Generate Your First Forecast

```bash
iload forecast \
  -s 2025-12-10 \
  -e 2025-12-10 \
  -o my_first_forecast.csv \
  --use-db \
  --model regression
```

This will:
- Load 90 days of historical data from database
- Fetch weather forecast from Visual Crossing API
- Train a regression model
- Generate 24-hour forecast
- Save to `my_first_forecast.csv`

### Step 5: View Your Forecast

Open `my_first_forecast.csv` in Excel or any text editor:
```csv
DateTimeEnding,Luzon,Visayas,Mindanao
12/10/2025 1:00,7850.5,1250.3,1520.2
12/10/2025 2:00,7620.8,1180.5,1450.7
...
```

Congratulations! You've generated your first forecast.

---

## Common Use Cases

### Use Case 1: Daily Operations Forecast

**Goal:** Generate next-day demand forecast every day

**Steps:**
1. Ensure yesterday's actual demand is imported
2. Generate 1-day ahead forecast
3. Review and use for planning

```bash
# Import yesterday's data
iload db import -t demand -f demand_yesterday.csv

# Generate tomorrow's forecast
iload forecast \
  -s $(date -d tomorrow +%Y-%m-%d) \
  -e $(date -d tomorrow +%Y-%m-%d) \
  -o forecast_tomorrow.csv \
  --use-db \
  --use-saved
```

### Use Case 2: Weekly Planning Forecast

**Goal:** Generate 7-day ahead forecast for weekly planning

```bash
iload forecast \
  -s 2025-12-10 \
  -e 2025-12-16 \
  -o forecast_week.csv \
  --use-db \
  --model hybrid \
  --growth 0.01
```

**Why hybrid model?**
- Adapts to demand growth trends
- Better for longer horizons
- Combines model + recent patterns

### Use Case 3: Renewable Generation Forecast

**Goal:** Forecast capacity factors for wind/solar stations

```bash
iload cfac forecast \
  -t "Data Samples/Capacity Factor/" \
  -s 2025-12-10 \
  -e 2025-12-10 \
  -o cfac_tomorrow.csv
```

**Output:** Hourly capacity factors (0.0 to 1.0) for each station

### Use Case 4: Outage Risk Assessment

**Goal:** Understand historical outage patterns

```bash
iload outage \
  -d "Data Samples/Outage Events/" \
  -o outage_analysis.md
```

**Output:** Markdown report with:
- Outage frequency by time/region
- Risk probabilities
- Recommendations

### Use Case 5: Model Performance Evaluation

**Goal:** Check how accurate your forecasts were

```bash
iload evaluate \
  -f forecast_last_week.csv \
  -a actual_last_week.csv \
  -o evaluation_report.md
```

**Output:** Detailed accuracy metrics and error analysis

---

## Understanding Model Types

### Regression Model
**Best for:**
- Quick forecasts
- Stable demand patterns
- When interpretability matters

**Pros:**
- Fast (< 1 second)
- Shows feature importance
- Reliable baseline

**Cons:**
- Assumes linear relationships
- May miss complex patterns

**Example:**
```bash
iload forecast ... --model regression
```

### XGBoost Model
**Best for:**
- Maximum accuracy
- Complex demand patterns
- Sufficient training data

**Pros:**
- Captures non-linear patterns
- Often highest accuracy
- Feature importance analysis

**Cons:**
- Slower training (10-30 seconds)
- Less interpretable
- Needs more data

**Example:**
```bash
iload forecast ... --model xgboost
```

### Hybrid Model
**Best for:**
- Growing demand scenarios
- Medium-term forecasts (3-7 days)
- Adapting to trends

**Pros:**
- Combines model + patterns
- Growth factor support
- Adaptive

**Cons:**
- Requires growth estimation
- More parameters

**Example:**
```bash
iload forecast ... --model hybrid --growth 0.01
```

---

## Configuration Guide

### API Key Setup

**Option 1: Environment Variable (Recommended)**
```bash
# Windows
setx VISUAL_CROSSING_API_KEY "your_key_here"

# Linux/Mac
echo 'export VISUAL_CROSSING_API_KEY="your_key_here"' >> ~/.bashrc
source ~/.bashrc
```

**Option 2: Config File**
Create `config.json` in project root:
```json
{
  "visualCrossingApiKey": "your_key_here"
}
```

### Database Location

Default: `data/iload.db`

To use custom location:
```typescript
// Modify in src/database/database.ts
constructor(dbPath?: string) {
  this.dbPath = dbPath || 'custom/path/to/db.sqlite';
}
```

### Weather Cache

Default: `weather_cache/`

Customize per command:
```bash
iload forecast ... --cache /path/to/custom/cache
```

**Cache benefits:**
- Reduces API calls
- Faster forecasts
- Offline capability (for cached dates)

---

## Data Management

### Importing Historical Data

**Demand Data:**
```bash
# Single file
iload db import -t demand -f demand_nov2024.csv

# Entire folder
iload db import -t demand -f "Data Samples/Training Historical Demand Data/"
```

**Weather Data:**
```bash
iload db import -t weather -f weather_manila.csv -l Manila
iload db import -t weather -f weather_cebu.csv -l Cebu
```

### Checking Database Contents

```bash
iload db status
```

**Output includes:**
- Record counts
- Date ranges
- Regions covered
- Storage size

### Managing Saved Models

**List models:**
```bash
iload db models
```

**Activate specific model:**
```bash
iload db models --activate 3
```

**When to activate a model:**
- After thorough evaluation
- When specific model performs best
- For consistent forecasting

### Clearing Database

**Warning:** This deletes ALL data!

```bash
iload db clear --confirm
```

---

## Forecast Tuning

### Scaling Forecasts

If your forecasts are consistently high or low:

```bash
# Reduce forecast by 3%
iload forecast ... --scale -3

# Increase forecast by 5%
iload forecast ... --scale 5
```

**How to determine scale factor:**
1. Generate forecast
2. Compare with actual (using evaluate)
3. Note bias percentage
4. Apply opposite scale

### Growth Adjustment (Hybrid Model)

For demand growth scenarios:

```bash
# 0.01% daily growth
iload forecast ... --model hybrid --growth 0.01

# 0.05% daily growth
iload forecast ... --model hybrid --growth 0.05
```

**Calculating growth rate:**
```
growth_rate = (recent_avg - older_avg) / older_avg / days_between * 100
```

### Training Period Selection

Default: 90 days

Adjust based on:
- Data availability
- Seasonal relevance
- Pattern stability

```bash
# Use 180 days
iload forecast ... --train-days 180

# Use 60 days (minimum recommended)
iload forecast ... --train-days 60
```

---

## Interpreting Results

### Demand Forecast Output

```csv
DateTimeEnding,Luzon,Visayas,Mindanao
12/10/2025 1:00,7850.5,1250.3,1520.2
```

**Values:** Predicted demand in Megawatts (MW)
**Resolution:** Hourly
**Regions:**
- Luzon: Largest grid (North)
- Visayas: Central grid
- Mindanao: Southern grid

### Capacity Factor Output

```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
12/10/2025 1:00,0.82,0.45,0.88,...
```

**Values:** Capacity factor (0.0 to 1.0)
- 0.0 = No generation
- 0.5 = 50% of installed capacity
- 1.0 = Full capacity

**Station naming:**
- First 2 digits: Region code (01=Luzon, 02=Visayas, 03=Mindanao)
- Rest: Station name

### Training Reports

Located in `output/` folder:

**regression_report.md:**
- Model coefficients
- Feature importance
- Training metrics
- Validation results

**xgboost_report.md:**
- Feature importance
- Training/validation metrics
- Model parameters

**comparison.md:**
- Side-by-side metrics
- Model recommendations

### Evaluation Metrics

**MAPE (Mean Absolute Percentage Error):**
- < 5%: Excellent
- 5-10%: Good
- > 10%: Needs improvement

**Bias:**
- Positive: Over-forecasting (reduce with --scale)
- Negative: Under-forecasting (increase with --scale)

---

## Troubleshooting

### Issue: "No training samples available"

**Symptoms:** Error during forecast generation

**Causes:**
- Insufficient historical data (< 7 days)
- Date mismatch between demand and weather
- Data quality issues

**Solutions:**
1. Check data availability:
   ```bash
   iload db status
   ```

2. Verify date range covers training period

3. Import more historical data:
   ```bash
   iload db import -t demand -f additional_data.csv
   ```

### Issue: Weather API failures

**Symptoms:**
- "Failed to fetch weather data"
- API quota errors

**Solutions:**
1. Verify API key:
   ```bash
   echo $VISUAL_CROSSING_API_KEY
   ```

2. Check API quota at visualcrossing.com

3. Use cached data if available (automatic)

4. Wait and retry (API has rate limits)

### Issue: Poor forecast accuracy

**Symptoms:** MAPE > 10% in evaluation

**Solutions:**
1. **Increase training data:**
   ```bash
   iload forecast ... --train-days 180
   ```

2. **Try different model:**
   ```bash
   iload forecast ... --model xgboost
   ```

3. **Apply scaling:**
   ```bash
   # After evaluation shows +5% bias
   iload forecast ... --scale -5
   ```

4. **Check data quality:**
   - Verify no gaps in historical data
   - Ensure weather data is accurate
   - Look for anomalies in training period

### Issue: Slow performance

**Symptoms:** Long wait times for forecasts

**Solutions:**
1. **Use saved models:**
   ```bash
   iload forecast ... --use-saved
   ```

2. **Reduce training period:**
   ```bash
   iload forecast ... --train-days 60
   ```

3. **Use regression instead of XGBoost:**
   ```bash
   iload forecast ... --model regression
   ```

4. **Ensure weather is cached** (happens automatically)

### Issue: Database errors

**Symptoms:**
- "Database locked"
- "Cannot open database"

**Solutions:**
1. Close other database connections

2. Check file permissions

3. Backup and recreate database:
   ```bash
   cp data/iload.db data/iload_backup.db
   iload db clear --confirm
   # Re-import data
   ```

---

## Best Practices

### Daily Operations

1. **Consistent schedule:** Run forecasts same time daily
2. **Data hygiene:** Import yesterday's actual every morning
3. **Model maintenance:** Retrain monthly
4. **Accuracy tracking:** Evaluate weekly
5. **Backup database:** Daily or weekly

### Data Quality

1. **Verify imports:** Always check `iload db status` after import
2. **Date alignment:** Ensure demand and weather dates match
3. **Missing data:** Address gaps before training
4. **Outliers:** Investigate unusual values in historical data

### Model Management

1. **Train regularly:** Monthly retraining with latest data
2. **Compare models:** Use `--model both` to evaluate
3. **Version control:** Keep best models activated
4. **Document changes:** Note when/why models are retrained

### Forecast Workflow

1. **Import data** → 2. **Check status** → 3. **Generate forecast** → 4. **Evaluate accuracy** → 5. **Adjust if needed**

---

## Advanced Features

### Multi-Region Forecasting

Forecasts automatically cover all regions in your data:
- Luzon
- Visayas
- Mindanao

No special flags needed - regions detected from data.

### Progressive Forecasting

For multi-day forecasts, each hour's prediction becomes input for next hour:
- Uses lag features intelligently
- Maintains temporal consistency
- Hybrid model excels at this

### Similar Days Matching

When historical data is missing:
- Finds similar days (same hour, day type, temperature)
- Uses average of last 7 matching days
- Prevents cold-start problems

### Weather Clustering

For capacity factor forecasting:
- Stations grouped by geographic proximity
- Each cluster has one weather fetch point
- Reduces API calls while maintaining accuracy

---

## FAQ

**Q: How much historical data do I need?**
A: Minimum 30 days, recommended 90 days, optimal 180+ days

**Q: Can I forecast beyond 7 days?**
A: Yes, but accuracy decreases. Weather forecast accuracy is limiting factor.

**Q: What if I don't have weather data?**
A: Use `forecast` command - it auto-fetches from Visual Crossing API

**Q: Can I use my own weather data?**
A: Yes, import with `iload db import -t weather -f yourdata.csv -l Location`

**Q: How often should I retrain models?**
A: Monthly recommended, or when demand patterns change significantly

**Q: Can I run multiple forecasts in parallel?**
A: Yes, but be mindful of API rate limits and database locking

**Q: What's the difference between --use-db and -d?**
A: `--use-db` loads from database, `-d` loads from CSV file

**Q: How do I backup my data?**
A: Copy `data/iload.db` file to safe location

**Q: Can I use this for other countries?**
A: Yes, but update location mappings in source code

**Q: What happens if API key is invalid?**
A: Forecast will fail. Verify key at visualcrossing.com

---

## Getting Help

### Documentation
- `APPLICATION_OVERVIEW.md` - System architecture
- `CLI_REFERENCE.md` - Complete command reference
- `DEVELOPER_GUIDE.md` - Technical details
- `SERVICE_USER_GUIDE.md` - Automated service setup

### Command Help
```bash
iload --help              # General help
iload forecast --help     # Command-specific help
```

### Common Resources
- Visual Crossing API: https://www.visualcrossing.com/
- TypeScript Docs: https://www.typescriptlang.org/
- XGBoost: https://xgboost.readthedocs.io/

---

## Next Steps

Now that you're familiar with the basics:

1. **Set up automated daily forecasting** (see SERVICE_USER_GUIDE.md)
2. **Explore advanced model tuning** (see DEVELOPER_GUIDE.md)
3. **Integrate with your systems** via CSV outputs
4. **Monitor and improve** forecast accuracy over time

**Happy Forecasting!**

---

**Document Version:** 1.0
**Last Updated:** 2025-12-10
**For Technical Details:** See DEVELOPER_GUIDE.md
