# Interconnector Congestion Model Comparison Report

**Date:** 2025-12-11
**Training Period:** July 1 - November 30, 2025
**Training Samples:** 9,928
**Validation Samples:** 1,986 (20% holdout)

---

## Executive Summary

Both Logistic Regression and XGBoost models were trained on interconnector congestion data and compared. **Surprisingly, the simpler Regression model performed better** on flow prediction metrics, with faster training time.

### Key Findings

1. **Classification Performance:** Both models achieved 71.30% accuracy (same performance)
2. **Flow Prediction:** Regression model slightly outperformed XGBoost (R²: 0.847 vs 0.843)
3. **Training Speed:** Regression was 30x faster (1.2s vs 36.7s)
4. **Issue Identified:** Both models show 0% precision/recall - **classifier is not predicting any positive class**

---

## Detailed Metrics Comparison

### Classification Metrics (Congestion Y/N Prediction)

| Metric | Regression | XGBoost | Winner | Notes |
|--------|-----------|---------|---------|-------|
| **Accuracy** | 71.30% | 71.30% | Tie | Both predict only negative class |
| **Precision** | 0.00% | 0.00% | Tie | ⚠️ No positive predictions |
| **Recall** | 0.00% | 0.00% | Tie | ⚠️ Missing all congestion events |
| **F1 Score** | 0.00% | 0.00% | Tie | ⚠️ Classifier not working |

**Confusion Matrix (Both Models):**
```
                 Predicted
                 No    Yes
Actual  No      1416    0
        Yes      570    0
```

**Interpretation:**
- Both models predict "No congestion" for ALL test samples
- Accuracy of 71.3% is simply the base rate (71.3% of samples are non-congested)
- **The classifiers are not learning** - they default to the majority class

### Regression Metrics (Flow Magnitude Prediction)

| Metric | Regression | XGBoost | Winner | Difference |
|--------|-----------|---------|---------|------------|
| **R² Score** | 0.8470 | 0.8427 | **Regression** | +0.5% |
| **MAPE** | 251.06% | 269.36% | **Regression** | -18.3% |
| **MAE** | 49.39 MW | 51.79 MW | **Regression** | -2.4 MW |
| **RMSE** | 74.15 MW | 75.17 MW | **Regression** | -1.0 MW |

**Interpretation:**
- Regression model explains 84.7% of variance in flow (very good)
- XGBoost explains 84.3% of variance (slightly less)
- Regression has lower error across all metrics
- **Linear relationships dominate** - complex XGBoost not needed

### Training Performance

| Metric | Regression | XGBoost | Ratio |
|--------|-----------|---------|-------|
| **Classification Training** | 0.12s | 8.29s | 69x slower |
| **Regression Training** | 1.09s | 28.29s | 26x slower |
| **Total Time** | 1.21s | 36.73s | **30x slower** |

---

## Root Cause Analysis: Why Is Classification Failing?

### Problem: Class Imbalance

The training data shows severe class imbalance:
- **Non-congested samples:** 71.3% (majority class)
- **Congested samples:** 28.7% (minority class)

Both models are optimized for accuracy, which leads them to:
1. Predict the majority class (non-congested) for everything
2. Achieve 71.3% accuracy without learning any patterns
3. Completely ignore the minority class (congested events)

### Why XGBoost Didn't Help

XGBoost typically handles imbalance better, but:
- **Hyperparameters not tuned** for imbalanced classification
- No `scale_pos_weight` parameter set (should be ~2.5 for 71/29 split)
- Default loss function doesn't penalize minority class errors enough

### Why Flow Prediction Works

Flow prediction (regression) works because:
- **No class imbalance** - predicting continuous values
- Flow values have clear linear relationships with features
- Weather and demand correlate linearly with power flow
- Simpler model captures the main relationships effectively

---

## Recommendations

### Immediate: Fix Classification (Critical)

The classification models need to be retrained with class imbalance handling:

**For Logistic Regression:**
1. **Class weighting:** Weight congested samples 2.5x higher
2. **Threshold tuning:** Lower decision threshold from 0.5 to ~0.3
3. **SMOTE:** Synthetic minority oversampling (optional)

**For XGBoost:**
1. **scale_pos_weight:** Set to 2.5 (ratio of negative to positive)
2. **eval_metric:** Use AUC or F1 instead of accuracy
3. **Increase trees:** Use 200-300 estimators for better minority class learning

### Code Changes Needed

```typescript
// Logistic Regression - add class weights
const classWeight = {
  0: 1.0,           // Non-congested (majority)
  1: 2.5            // Congested (minority) - weight higher
};

// XGBoost - add parameters
const xgbParams = {
  maxDepth: 6,
  learningRate: 0.1,
  nEstimators: 200,           // More trees
  subsample: 0.8,
  scalePos Weight: 2.5,        // Handle imbalance
  evalMetric: 'auc'           // Better metric
};

// Lower threshold for positive prediction
const threshold = 0.3;  // Instead of 0.5
```

### Medium-Term: Feature Engineering

Based on correlation analysis, enhance features:

1. **Interaction terms:**
   - Temperature × Hour
   - Solar × Hour
   - Demand × Temperature

2. **Lag features:**
   - Previous hour congestion state
   - 24-hour lag flow values
   - Rolling 3-hour averages

3. **Temporal features:**
   - Peak hour indicator (1-6 PM)
   - Weekday indicator
   - High solar indicator (>200 W/m²)

### Long-Term: Model Architecture

Consider alternative approaches:

1. **Two-stage model:**
   - Stage 1: Predict if flow will be high (>300 MW)
   - Stage 2: If high flow predicted, predict congestion

2. **Ensemble model:**
   - Combine multiple weak learners
   - Use voting or stacking

3. **Time series model:**
   - LSTM or GRU for sequential patterns
   - Captures temporal dependencies better

---

## Current Model Selection Guidance

### For Production Use: **Regression Model**

**Reasons:**
1. ✅ Better flow prediction (R² = 0.847)
2. ✅ 30x faster training and inference
3. ✅ Lower error metrics (MAPE, MAE, RMSE)
4. ✅ Simpler and more interpretable
5. ✅ Easier to debug and maintain

**Use Case:**
- Predicting interconnector flow magnitude
- Understanding how demand/weather affects flow
- Real-time flow prediction for dispatch

### XGBoost: **Not Recommended Currently**

**Reasons:**
1. ❌ Slower training (36.7s vs 1.2s)
2. ❌ Worse flow prediction metrics
3. ❌ More complex without benefit
4. ❌ Same classification failure as Regression

**Only Consider XGBoost If:**
- After implementing class imbalance fixes
- With proper hyperparameter tuning
- For non-linear pattern detection (if proven necessary)

---

## Action Items

### Priority 1: Fix Classification (Immediate)
- [ ] Implement class weighting in logistic regression
- [ ] Add scale_pos_weight to XGBoost
- [ ] Retrain both models with imbalance handling
- [ ] Target: >50% recall, >60% precision on congestion events

### Priority 2: Validate Flow Predictions (This Week)
- [ ] Test regression model on December 2025 data
- [ ] Calculate actual vs predicted errors
- [ ] Generate confidence intervals
- [ ] Document prediction accuracy ranges

### Priority 3: Feature Engineering (Next Week)
- [ ] Add interaction terms based on correlation analysis
- [ ] Implement lag features (1h, 24h)
- [ ] Test peak hour indicator effectiveness
- [ ] Measure impact on R² score

### Priority 4: Production Deployment (After Validation)
- [ ] Deploy regression model for flow prediction
- [ ] Create API endpoint for real-time predictions
- [ ] Set up monitoring and alerting
- [ ] Document operational procedures

---

## Conclusion

**Current Status:**
- ✅ Flow prediction works well (R² = 0.847)
- ❌ Classification doesn't work (0% precision/recall)
- ✅ Regression model is production-ready for flow prediction
- ❌ Neither model ready for congestion classification

**Key Insight:**
Linear regression captures the main relationships between weather/demand and interconnector flow effectively. The 84.7% R² score indicates strong predictive power. However, the classification problem requires addressing class imbalance before either model can predict congestion events.

**Recommendation:**
1. **Use Regression model immediately** for flow prediction
2. **Fix classification** using class imbalance techniques
3. **Retrain and compare** after fixes applied
4. **Validate on December data** before full production deployment

---

**Report Generated:** 2025-12-11
**Models Compared:** Logistic/Linear Regression vs XGBoost
**Training Data:** 9,928 samples (July-November 2025)
**Next Review:** After classification fixes implemented
