# XGBoost Interconnector Model - Quick Reference

## Command Reference

### Training Commands

#### Train Both Models (Recommended for First Run)
```bash
iload interconnector train --start 2025-07-01 --end 2025-07-31 --model both
```
**Output:** Both models trained + comparison report + recommendations

#### Train XGBoost Only
```bash
iload interconnector train --start 2025-07-01 --end 2025-07-31 --model xgboost
```
**Output:** XGBoost model + feature importance

#### Train Regression Only
```bash
iload interconnector train --start 2025-07-01 --end 2025-07-31 --model regression
```
**Output:** Logistic + Linear regression model

### Forecast Commands

#### Use Specific Model Type
```bash
# Use XGBoost model
iload interconnector forecast -s 2025-08-01 -e 2025-08-07 -o forecast.csv --model-type xgboost

# Use Regression model
iload interconnector forecast -s 2025-08-01 -e 2025-08-07 -o forecast.csv --model-type regression
```

#### Use Active Model (Default)
```bash
iload interconnector forecast -s 2025-08-01 -e 2025-08-07 -o forecast.csv
```
**Note:** Uses the most recently trained model (whichever was trained last)

## Model Comparison Metrics

### Classification Metrics (Congestion Prediction)
- **Accuracy**: Overall correctness (higher is better)
- **Precision**: Of predicted congestions, how many were correct (higher is better)
- **Recall**: Of actual congestions, how many were detected (higher is better)
- **F1 Score**: Balance between precision and recall (higher is better)

### Regression Metrics (Flow Prediction)
- **R² Score**: How well the model explains variance (closer to 1 is better)
- **MAPE**: Mean Absolute Percentage Error (lower is better)
- **MAE**: Mean Absolute Error in MW (lower is better)
- **RMSE**: Root Mean Square Error in MW (lower is better)

## Expected Performance

### Typical Results (on good training data)

**Regression Model:**
- Accuracy: 85-90%
- R² Score: 0.75-0.85
- Training Time: 1-5 seconds

**XGBoost Model:**
- Accuracy: 88-93%
- R² Score: 0.80-0.90
- Training Time: 10-30 seconds

**Performance Gain:**
- 2-5% improvement in classification accuracy
- 0.05-0.10 improvement in R² score
- 15-25% reduction in flow prediction error (MAE/RMSE)

## When to Use Each Model

### Use Regression When:
- Fast training is required (< 5 seconds)
- Model needs frequent retraining
- Interpretability is critical (simple linear relationships)
- Dataset is small (< 1000 samples)
- Production environment has strict latency requirements

### Use XGBoost When:
- Maximum accuracy is required
- Training time is not critical
- Data shows non-linear patterns
- Dataset is large (> 5000 samples)
- Feature importance analysis is needed
- Complex interactions between features exist

## Feature Importance

Top features typically identified by XGBoost:

1. **Flow Lags** (flowLag1h, flowLag24h)
   - Previous hour/day flow patterns strongly predict congestion

2. **Congestion History** (congestionLag1h, congestionCount24h)
   - Recent congestion events indicate future congestion

3. **Demand Differences** (demandDiff_CV, demandDiff_CM)
   - Regional demand imbalances drive interconnector flow

4. **Solar Radiation** (solarCVIS, solarCLUZ)
   - Strong predictor due to impact on solar generation

5. **Temporal Features** (hour, dayOfWeek)
   - Daily and weekly patterns in congestion

## Troubleshooting

### No Model Found Error
```
❌ No saved model found. Train a model first using "interconnector train".
```
**Solution:** Train a model first using one of the training commands above

### Invalid Model Type Error
```
❌ Invalid model type. Use: regression, xgboost, or both
```
**Solution:** Check spelling of --model parameter (should be lowercase)

### Not Enough Training Samples
```
❌ Not enough training samples (need at least 100). Import more historical data.
```
**Solution:** Import more RTDHS interconnector data, demand data, and weather data

### Missing Data Error
```
❌ Missing demand or weather data. Import historical data first.
```
**Solution:**
```bash
# Import demand data
iload db import -t demand -f path/to/demand.csv

# Import weather data (for each region)
iload db import -t weather -f path/to/weather.csv -l Manila
iload db import -t weather -f path/to/weather.csv -l "Cebu City"
iload db import -t weather -f path/to/weather.csv -l "Davao City"

# Import interconnector data
iload interconnector import -f "Z:\\WESM FILES\\RTDHS\\" --start 2025-07-01 --end 2025-07-31
```

## Best Practices

1. **Initial Training**: Always use `--model both` first to compare performance
2. **Date Range**: Use at least 30 days of data for training
3. **Model Selection**: Choose based on comparison report recommendations
4. **Retraining**: Retrain monthly with latest data to maintain accuracy
5. **Validation**: Always validate predictions against actual data when available

## Database Schema

Models are stored in `interconnector_models` table with:
- Separate entries for regression and xgboost models
- Only one active model per type at a time
- Full metrics stored (accuracy, precision, recall, F1, R², MAPE, MAE, RMSE)
- Training time recorded for performance comparison

## Example Workflow

```bash
# 1. Import required data
iload interconnector import -f "Z:\\WESM FILES\\RTDHS\\" --start 2025-01-01 --end 2025-06-30

# 2. Train both models and compare
iload interconnector train --start 2025-01-01 --end 2025-06-30 --model both

# 3. Review comparison report and choose model
# (Report will show which model performed better)

# 4. Generate forecasts using better model
iload interconnector forecast -s 2025-07-01 -e 2025-07-07 -o forecast.csv --model-type xgboost

# 5. (Future) Validate predictions against actual data
```

## Advanced Usage

### Custom Date Ranges
```bash
# Train on Q1 2025 data
iload interconnector train --start 2025-01-01 --end 2025-03-31 --model both

# Train on full year
iload interconnector train --start 2025-01-01 --end 2025-12-31 --model both
```

### Single Interconnector Training
```bash
# Train only for MINVIS1 (Mindanao-Visayas)
iload interconnector train --start 2025-07-01 --end 2025-07-31 -i MINVIS1 --model both

# Train only for VISLUZ1 (Visayas-Luzon)
iload interconnector train --start 2025-07-01 --end 2025-07-31 -i VISLUZ1 --model both
```

## Performance Optimization Tips

1. **XGBoost Training Speed**:
   - Reduce `nEstimators` (default: 100) for faster training
   - Increase `subsample` (default: 0.8) to use fewer samples
   - Reduce `maxDepth` (default: 6) for simpler trees

2. **Memory Usage**:
   - Train on specific date ranges instead of all data
   - Train per interconnector instead of both together
   - Use regression model for memory-constrained environments

3. **Prediction Speed**:
   - Regression model is 5-10x faster for predictions
   - Consider caching predictions for repeated queries
   - Use regression for real-time applications

## Support

For issues or questions:
1. Check `Documents/XGBOOST_IMPLEMENTATION_SUMMARY.md` for detailed information
2. Review `Documents/INTERCONNECTOR_IMPLEMENTATION_PLAN.md` for system architecture
3. Check build logs: `npm run build`
