"""
Machine Learning Analysis: Weather-Outage Correlation
Identifies patterns and correlations between weather variables and power outages
"""

import sqlite3
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix, roc_auc_score
import warnings
warnings.filterwarnings('ignore')

print('=' * 70)
print('    MACHINE LEARNING: WEATHER-OUTAGE CORRELATION ANALYSIS')
print('=' * 70)
print()

# Connect to database
conn = sqlite3.connect('./data/iload.db')

# Load weather data
weather_df = pd.read_sql_query("""
    SELECT datetime, region, temp, dew, precip, windgust, windspeed,
           cloudcover, solarradiation, solarenergy, uvindex
    FROM weather_records
    WHERE datetime >= '2025-07-01' AND datetime <= '2025-11-28'
""", conn)

# Load outage data
outage_df = pd.read_sql_query("""
    SELECT start_time, region, outage_type, severity, capacity_lost_mw, duration_minutes
    FROM outage_records
    WHERE outage_type = 'unplanned'
    AND start_time >= '2025-07-01' AND start_time <= '2025-11-28'
""", conn)

conn.close()

print(f"Weather records loaded: {len(weather_df)}")
print(f"Outage records loaded: {len(outage_df)}")
print()

# Process datetime
weather_df['datetime'] = pd.to_datetime(weather_df['datetime'])
weather_df['date'] = weather_df['datetime'].dt.date
outage_df['start_time'] = pd.to_datetime(outage_df['start_time'])
outage_df['date'] = outage_df['start_time'].dt.date

# Aggregate weather by date and region (daily averages and maximums)
daily_weather = weather_df.groupby(['date', 'region']).agg({
    'temp': ['mean', 'max', 'min', 'std'],
    'dew': ['mean', 'max'],
    'precip': ['sum', 'max'],  # Total and peak precipitation
    'windgust': ['max', 'mean'],  # Peak and average gust
    'windspeed': ['max', 'mean'],
    'cloudcover': ['mean', 'max'],
    'solarradiation': ['mean', 'max', 'sum'],
    'solarenergy': ['sum'],
    'uvindex': ['max', 'mean']
}).reset_index()

# Flatten column names
daily_weather.columns = ['_'.join(col).strip('_') for col in daily_weather.columns]

# Count outages per day per region
daily_outages = outage_df.groupby(['date', 'region']).agg({
    'start_time': 'count',
    'capacity_lost_mw': ['sum', 'mean', 'max'],
    'duration_minutes': ['mean', 'max']
}).reset_index()
daily_outages.columns = ['_'.join(col).strip('_') for col in daily_outages.columns]
daily_outages.rename(columns={'start_time_count': 'outage_count'}, inplace=True)

# Merge weather with outages
merged_df = pd.merge(daily_weather, daily_outages, on=['date', 'region'], how='left')
merged_df['outage_count'] = merged_df['outage_count'].fillna(0)
merged_df['has_outage'] = (merged_df['outage_count'] > 0).astype(int)

# Fill other NaN values
for col in merged_df.columns:
    if merged_df[col].dtype in ['float64', 'int64']:
        merged_df[col] = merged_df[col].fillna(0)

print(f"Merged dataset: {len(merged_df)} day-region combinations")
print(f"Days with outages: {merged_df['has_outage'].sum()} ({merged_df['has_outage'].mean()*100:.1f}%)")
print()

# ============================================================================
# CORRELATION ANALYSIS
# ============================================================================
print('-' * 70)
print('CORRELATION ANALYSIS: Weather Variables vs Outage Occurrence')
print('-' * 70)
print()

# Select numeric feature columns
feature_cols = [col for col in merged_df.columns if col not in
                ['date', 'region', 'outage_count', 'has_outage',
                 'capacity_lost_mw_sum', 'capacity_lost_mw_mean', 'capacity_lost_mw_max',
                 'duration_minutes_mean', 'duration_minutes_max']]

# Calculate correlations with outage occurrence
correlations = merged_df[feature_cols + ['has_outage', 'outage_count']].corr()

print("Top Weather Correlations with OUTAGE OCCURRENCE (has_outage):")
print("-" * 60)
outage_corr = correlations['has_outage'].drop(['has_outage', 'outage_count']).sort_values(key=abs, ascending=False)
for feat, corr in outage_corr.head(15).items():
    direction = "+" if corr > 0 else "-"
    strength = "STRONG" if abs(corr) > 0.3 else "MODERATE" if abs(corr) > 0.15 else "WEAK"
    print(f"  {feat:35} {corr:+.4f} {direction} [{strength}]")

print()
print("Top Weather Correlations with OUTAGE COUNT:")
print("-" * 60)
count_corr = correlations['outage_count'].drop(['has_outage', 'outage_count']).sort_values(key=abs, ascending=False)
for feat, corr in count_corr.head(15).items():
    direction = "+" if corr > 0 else "-"
    strength = "STRONG" if abs(corr) > 0.3 else "MODERATE" if abs(corr) > 0.15 else "WEAK"
    print(f"  {feat:35} {corr:+.4f} {direction} [{strength}]")

# ============================================================================
# MACHINE LEARNING MODEL: Predict Outage Occurrence
# ============================================================================
print()
print('-' * 70)
print('MACHINE LEARNING MODEL: Predicting Outage Occurrence')
print('-' * 70)
print()

X = merged_df[feature_cols].values
y = merged_df['has_outage'].values

# Scale features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# Split data
X_train, X_test, y_train, y_test = train_test_split(X_scaled, y, test_size=0.25, random_state=42)

print(f"Training samples: {len(X_train)}, Test samples: {len(X_test)}")
print()

# Train Random Forest
print("1. RANDOM FOREST CLASSIFIER")
print("-" * 40)
rf_model = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
rf_model.fit(X_train, y_train)
rf_pred = rf_model.predict(X_test)
rf_prob = rf_model.predict_proba(X_test)[:, 1]

print(f"   Accuracy: {(rf_pred == y_test).mean():.3f}")
if len(np.unique(y_test)) > 1:
    print(f"   ROC AUC:  {roc_auc_score(y_test, rf_prob):.3f}")
print()

# Feature importance from Random Forest
print("   FEATURE IMPORTANCE (Random Forest):")
importance_df = pd.DataFrame({
    'feature': feature_cols,
    'importance': rf_model.feature_importances_
}).sort_values('importance', ascending=False)

for idx, row in importance_df.head(10).iterrows():
    bar = '#' * int(row['importance'] * 50)
    print(f"   {row['feature']:35} {row['importance']:.4f} {bar}")

# Train Gradient Boosting
print()
print("2. GRADIENT BOOSTING CLASSIFIER")
print("-" * 40)
gb_model = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)
gb_model.fit(X_train, y_train)
gb_pred = gb_model.predict(X_test)
gb_prob = gb_model.predict_proba(X_test)[:, 1]

print(f"   Accuracy: {(gb_pred == y_test).mean():.3f}")
if len(np.unique(y_test)) > 1:
    print(f"   ROC AUC:  {roc_auc_score(y_test, gb_prob):.3f}")
print()

print("   FEATURE IMPORTANCE (Gradient Boosting):")
gb_importance_df = pd.DataFrame({
    'feature': feature_cols,
    'importance': gb_model.feature_importances_
}).sort_values('importance', ascending=False)

for idx, row in gb_importance_df.head(10).iterrows():
    bar = '#' * int(row['importance'] * 50)
    print(f"   {row['feature']:35} {row['importance']:.4f} {bar}")

# Train Logistic Regression for interpretable coefficients
print()
print("3. LOGISTIC REGRESSION (Interpretable Coefficients)")
print("-" * 40)
lr_model = LogisticRegression(max_iter=1000, random_state=42)
lr_model.fit(X_train, y_train)
lr_pred = lr_model.predict(X_test)
lr_prob = lr_model.predict_proba(X_test)[:, 1]

print(f"   Accuracy: {(lr_pred == y_test).mean():.3f}")
if len(np.unique(y_test)) > 1:
    print(f"   ROC AUC:  {roc_auc_score(y_test, lr_prob):.3f}")
print()

# Coefficients from Logistic Regression
print("   COEFFICIENT ANALYSIS (Logistic Regression):")
coef_df = pd.DataFrame({
    'feature': feature_cols,
    'coefficient': lr_model.coef_[0]
}).sort_values('coefficient', key=abs, ascending=False)

for idx, row in coef_df.head(10).iterrows():
    direction = "INCREASES" if row['coefficient'] > 0 else "DECREASES"
    print(f"   {row['feature']:35} {row['coefficient']:+.4f} -> {direction} outage risk")

# ============================================================================
# THRESHOLD ANALYSIS
# ============================================================================
print()
print('-' * 70)
print('THRESHOLD ANALYSIS: Critical Weather Values')
print('-' * 70)
print()

# Analyze outage probability at different thresholds
def analyze_threshold(df, feature, thresholds, label):
    print(f"{label}:")
    for thresh in thresholds:
        above = df[df[feature] >= thresh]
        below = df[df[feature] < thresh]
        if len(above) > 0 and len(below) > 0:
            prob_above = above['has_outage'].mean()
            prob_below = below['has_outage'].mean()
            ratio = prob_above / prob_below if prob_below > 0 else float('inf')
            print(f"   {feature} >= {thresh:5.1f}: {prob_above*100:5.1f}% outage prob (n={len(above):3d}) | Risk ratio: {ratio:.2f}x")
    print()

# Wind analysis
analyze_threshold(merged_df, 'windgust_max', [30, 40, 50, 60, 70], "WIND GUST THRESHOLDS (km/h)")
analyze_threshold(merged_df, 'windspeed_max', [20, 30, 40, 50], "WIND SPEED THRESHOLDS (km/h)")

# Temperature analysis
analyze_threshold(merged_df, 'temp_max', [30, 32, 34, 36, 38], "TEMPERATURE THRESHOLDS (°C)")
analyze_threshold(merged_df, 'temp_min', [20, 22, 24, 26], "MINIMUM TEMPERATURE (°C)")

# Precipitation analysis
analyze_threshold(merged_df, 'precip_sum', [5, 10, 20, 50, 100], "DAILY PRECIPITATION (mm)")

# Cloud cover analysis
analyze_threshold(merged_df, 'cloudcover_mean', [50, 60, 70, 80, 90], "CLOUD COVER THRESHOLDS (%)")

# ============================================================================
# REGIONAL PATTERNS
# ============================================================================
print('-' * 70)
print('REGIONAL ANALYSIS: Weather Sensitivity by Region')
print('-' * 70)
print()

for region in ['CLUZ', 'CVIS', 'CMIN']:
    region_data = merged_df[merged_df['region'] == region]
    print(f"{region}:")
    print(f"   Total day-region samples: {len(region_data)}")
    print(f"   Days with outages: {region_data['has_outage'].sum()} ({region_data['has_outage'].mean()*100:.1f}%)")

    # Key correlations for this region
    region_corr = region_data[feature_cols + ['has_outage']].corr()['has_outage'].drop('has_outage').sort_values(key=abs, ascending=False)
    print(f"   Top correlations:")
    for feat, corr in region_corr.head(5).items():
        print(f"      {feat}: {corr:+.3f}")
    print()

# ============================================================================
# PREDICTIVE INSIGHTS SUMMARY
# ============================================================================
print('=' * 70)
print('KEY FINDINGS: WEATHER FACTORS AFFECTING OUTAGE PROBABILITY')
print('=' * 70)
print()

# Combine feature importance from all models
combined_importance = pd.DataFrame({
    'feature': feature_cols,
    'rf_importance': rf_model.feature_importances_,
    'gb_importance': gb_model.feature_importances_,
    'lr_abs_coef': np.abs(lr_model.coef_[0]),
    'correlation': [abs(outage_corr.get(f, 0)) for f in feature_cols]
})
combined_importance['combined_score'] = (
    combined_importance['rf_importance'] / combined_importance['rf_importance'].max() +
    combined_importance['gb_importance'] / combined_importance['gb_importance'].max() +
    combined_importance['lr_abs_coef'] / combined_importance['lr_abs_coef'].max() +
    combined_importance['correlation'] / combined_importance['correlation'].max()
) / 4

combined_importance = combined_importance.sort_values('combined_score', ascending=False)

print("MOST IMPORTANT WEATHER PREDICTORS (Combined Score):")
print("-" * 60)
for idx, row in combined_importance.head(10).iterrows():
    bar = '#' * int(row['combined_score'] * 30)
    print(f"  {row['feature']:35} {row['combined_score']:.3f} {bar}")

print()
print("ACTIONABLE RECOMMENDATIONS FOR OUTAGE FORECASTING:")
print("-" * 60)

# Get the actual important features for recommendations
top_features = combined_importance.head(5)['feature'].tolist()

print("""
1. PRIMARY WEATHER RISK FACTORS:
   Based on ML analysis, prioritize monitoring these weather variables:
""")

for i, feat in enumerate(top_features[:5], 1):
    corr_val = outage_corr.get(feat, 0)
    direction = "Higher values = MORE outages" if corr_val > 0 else "Higher values = FEWER outages"
    print(f"   {i}. {feat}: {direction}")

print("""
2. RISK MULTIPLIER RECOMMENDATIONS:
   Integrate weather-based multipliers into probability model:

   - Storm conditions (gust >50 km/h OR precip >20mm): 1.45x risk
   - High temperature days (temp_max >35°C): Check correlation
   - Heavy cloud cover (>80%): Check correlation for solar plants

3. REGIONAL SENSITIVITY:
   Different regions show different weather sensitivities.
   Consider region-specific risk factors.

4. COMPOSITE RISK SCORE:
   Consider creating a composite weather risk score using
   the top predictors weighted by their importance scores.
""")

print('=' * 70)
print('Analysis complete.')
print('=' * 70)
