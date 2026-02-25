#!/usr/bin/env python3
"""
Fast LSTM trainer for demand correction using TensorFlow/Keras.
Exports model weights to JSON for JavaScript inference.

Usage:
    python scripts/train_demand_lstm.py --zone 01NLUZ --output models/lstm_01NLUZ.json
    python scripts/train_demand_lstm.py --all --output models/  # Train all zones
"""

import argparse
import json
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta
import numpy as np

try:
    import tensorflow as tf
    from tensorflow import keras
    from tensorflow.keras import layers
except ImportError:
    print("TensorFlow not installed. Install with: pip install tensorflow")
    sys.exit(1)

try:
    import pandas as pd
except ImportError:
    print("Pandas not installed. Install with: pip install pandas")
    sys.exit(1)

# Suppress TF warnings
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
tf.get_logger().setLevel('ERROR')

# Feature configuration (must match JS implementation)
SEQUENCE_LENGTH = 24  # hours
FEATURES_PER_TIMESTEP = 22
CORRECTION_MIN = 0.85
CORRECTION_MAX = 1.15

ZONES = [
    '01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS',
    '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN',
    '13SEMIN', '14SWMIN'
]


def load_demand_data(data_dir: str) -> pd.DataFrame:
    """Load and merge demand CSV files."""
    data_dir = Path(data_dir)
    all_records = []

    # Find all demand files
    csv_files = list(data_dir.glob('*.csv'))
    if not csv_files:
        raise FileNotFoundError(f"No CSV files found in {data_dir}")

    for csv_file in csv_files:
        try:
            df = pd.read_csv(csv_file, encoding='utf-8-sig')

            # Handle DateTimeEnding format (M/D/YYYY HH:MM)
            if 'DateTimeEnding' in df.columns:
                df['datetime'] = pd.to_datetime(df['DateTimeEnding'], format='%m/%d/%Y %H:%M')
                df = df.drop(columns=['DateTimeEnding'])
            elif 'datetime' in df.columns:
                df['datetime'] = pd.to_datetime(df['datetime'])
            elif 'DATE' in df.columns and 'TIME' in df.columns:
                df['datetime'] = pd.to_datetime(df['DATE'] + ' ' + df['TIME'])
            else:
                print(f"  Warning: Unknown date format in {csv_file.name}")
                continue

            all_records.append(df)
        except Exception as e:
            print(f"  Warning: Could not parse {csv_file.name}: {e}")

    if not all_records:
        raise ValueError("No valid demand data found")

    combined = pd.concat(all_records, ignore_index=True)
    combined = combined.sort_values('datetime').drop_duplicates(subset=['datetime'])
    return combined


def load_weather_data(weather_dir: str, zone: str) -> pd.DataFrame:
    """Load weather data for a zone."""
    weather_dir = Path(weather_dir)

    # Look for zonal weather files
    zone_lower = zone.lower()
    pattern = f"*{zone_lower}*.csv"
    weather_files = list(weather_dir.glob(f"zonal/{pattern}"))

    if not weather_files:
        # Try alternative patterns
        weather_files = list(weather_dir.glob(f"**/*{zone_lower}*.csv"))

    if not weather_files:
        print(f"  Warning: No weather data found for zone {zone}")
        return pd.DataFrame()

    all_weather = []
    for wf in weather_files[:1]:  # Use first matching file
        try:
            df = pd.read_csv(wf, encoding='utf-8-sig')
            if 'datetime' in df.columns:
                df['datetime'] = pd.to_datetime(df['datetime'])
            all_weather.append(df)
        except Exception as e:
            print(f"  Warning: Could not parse {wf.name}: {e}")

    if not all_weather:
        return pd.DataFrame()

    return pd.concat(all_weather, ignore_index=True)


def extract_features(demand_df: pd.DataFrame, weather_df: pd.DataFrame, zone: str) -> tuple:
    """Extract features for LSTM training."""

    # Check if zone column exists
    if zone not in demand_df.columns:
        print(f"  Warning: Zone {zone} not found in demand data (columns: {list(demand_df.columns)[:5]}...)")
        return None, None

    # Get zone data
    zone_data = demand_df[['datetime', zone]].copy()
    zone_data.columns = ['datetime', 'demand']

    zone_data = zone_data.dropna()
    zone_data = zone_data.sort_values('datetime')

    if len(zone_data) < SEQUENCE_LENGTH + 1:
        print(f"  Warning: Insufficient data for zone {zone}")
        return None, None

    # Merge with weather if available
    if not weather_df.empty and 'datetime' in weather_df.columns:
        zone_data = zone_data.merge(weather_df, on='datetime', how='left')

    # Build feature sequences
    sequences = []
    targets = []

    demands = zone_data['demand'].values
    datetimes = zone_data['datetime'].values

    # Get weather features if available
    has_weather = 'temp' in zone_data.columns

    for i in range(SEQUENCE_LENGTH, len(zone_data) - 1):
        seq_features = []

        for j in range(i - SEQUENCE_LENGTH, i):
            dt = pd.Timestamp(datetimes[j])
            demand = demands[j]

            # Temporal features (cyclical encoding)
            hour_sin = np.sin(2 * np.pi * dt.hour / 24)
            hour_cos = np.cos(2 * np.pi * dt.hour / 24)
            dow_sin = np.sin(2 * np.pi * dt.dayofweek / 7)
            dow_cos = np.cos(2 * np.pi * dt.dayofweek / 7)
            month_sin = np.sin(2 * np.pi * dt.month / 12)
            month_cos = np.cos(2 * np.pi * dt.month / 12)

            # Day type flags
            is_weekend = 1.0 if dt.dayofweek >= 5 else 0.0
            is_holiday = 0.0  # Simplified - would need holiday data

            # Time period flags
            is_morning_ramp = 1.0 if 6 <= dt.hour <= 9 else 0.0
            is_evening_peak = 1.0 if 17 <= dt.hour <= 22 else 0.0

            # Demand features (normalized)
            demand_norm = demand / 10000.0  # Normalize to roughly 0-1

            # Lag features
            demand_1h = demands[j-1] / 10000.0 if j > 0 else demand_norm
            demand_24h = demands[j-24] / 10000.0 if j >= 24 else demand_norm

            # Weather features (default values if not available)
            if has_weather:
                row = zone_data.iloc[j]
                temp = row.get('temp', 28.0)
                humidity = row.get('humidity', 70.0)
                cloud_cover = row.get('cloudcover', 50.0)
            else:
                temp, humidity, cloud_cover = 28.0, 70.0, 50.0

            # Normalize weather
            temp_norm = (temp - 20) / 20.0  # Roughly -0.5 to 1.0
            humidity_norm = humidity / 100.0
            cloud_norm = cloud_cover / 100.0

            # Temperature momentum
            temp_change_1h = 0.0  # Would need historical temp data
            temp_change_3h = 0.0

            # Heat index (simplified)
            heat_index = temp_norm

            # Days since/until holiday (simplified)
            days_since_holiday = 7.0 / 14.0
            days_until_holiday = 7.0 / 14.0

            # Build feature vector (22 features)
            features = [
                temp_norm,           # 1. Temperature
                temp_change_1h,      # 2. Temp change 1h
                temp_change_3h,      # 3. Temp change 3h
                humidity_norm,       # 4. Humidity
                heat_index,          # 5. Heat index
                cloud_norm,          # 6. Cloud cover
                demand_norm,         # 7. Current demand
                demand_1h - demand_norm,  # 8. Demand change 1h
                demand_24h,          # 9. Demand same hour yesterday
                demand_24h,          # 10. Demand same hour last week (simplified)
                hour_sin,            # 11. Hour sin
                hour_cos,            # 12. Hour cos
                dow_sin,             # 13. Day of week sin
                dow_cos,             # 14. Day of week cos
                month_sin,           # 15. Month sin
                month_cos,           # 16. Month cos
                is_weekend,          # 17. Is weekend
                is_holiday,          # 18. Is holiday
                days_since_holiday,  # 19. Days since holiday
                days_until_holiday,  # 20. Days until holiday
                is_morning_ramp,     # 21. Is morning ramp
                is_evening_peak,     # 22. Is evening peak
            ]

            seq_features.append(features)

        # Target: correction factor for next hour
        actual_next = demands[i]
        # Use simple moving average as "hybrid prediction"
        window = min(168, i)
        hybrid_pred = np.mean(demands[i-window:i])

        correction = actual_next / hybrid_pred if hybrid_pred > 0 else 1.0
        correction = np.clip(correction, CORRECTION_MIN, CORRECTION_MAX)
        # Normalize to 0-1 range
        target = (correction - CORRECTION_MIN) / (CORRECTION_MAX - CORRECTION_MIN)

        sequences.append(seq_features)
        targets.append(target)

    return np.array(sequences, dtype=np.float32), np.array(targets, dtype=np.float32)


def build_model(sequence_length: int, n_features: int) -> keras.Model:
    """Build LSTM model."""
    model = keras.Sequential([
        layers.Input(shape=(sequence_length, n_features)),
        layers.LSTM(32, return_sequences=True),
        layers.Dropout(0.2),
        layers.LSTM(16),
        layers.Dropout(0.2),
        layers.Dense(8, activation='relu'),
        layers.Dense(1, activation='sigmoid')  # Output 0-1
    ])

    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=0.001),
        loss='mse',
        metrics=['mae']
    )

    return model


def export_model_weights(model: keras.Model, output_path: str, zone: str, metrics: dict):
    """Export model weights to JSON for JavaScript inference."""
    weights = {}

    for i, layer in enumerate(model.layers):
        layer_weights = layer.get_weights()
        if layer_weights:
            weights[f"layer_{i}_{layer.name}"] = {
                "type": layer.__class__.__name__,
                "weights": [w.tolist() for w in layer_weights]
            }

    output = {
        "zone": zone,
        "sequence_length": SEQUENCE_LENGTH,
        "features_per_timestep": FEATURES_PER_TIMESTEP,
        "correction_min": CORRECTION_MIN,
        "correction_max": CORRECTION_MAX,
        "architecture": [layer.name for layer in model.layers],
        "weights": weights,
        "metrics": metrics,
        "trained_at": datetime.now().isoformat()
    }

    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"  Exported weights to {output_path}")


def train_zone(zone: str, demand_dir: str, weather_dir: str, output_dir: str, epochs: int = 50):
    """Train LSTM for a single zone."""
    print(f"\nTraining LSTM for zone {zone}...")

    # Load data
    try:
        demand_df = load_demand_data(demand_dir)
        print(f"  Loaded {len(demand_df)} demand records")
    except Exception as e:
        print(f"  Error loading demand data: {e}")
        return None

    weather_df = pd.DataFrame()
    if weather_dir and os.path.exists(weather_dir):
        try:
            weather_df = load_weather_data(weather_dir, zone)
            if not weather_df.empty:
                print(f"  Loaded {len(weather_df)} weather records")
        except Exception as e:
            print(f"  Warning: Could not load weather data: {e}")

    # Extract features
    X, y = extract_features(demand_df, weather_df, zone)
    if X is None:
        print(f"  Skipping zone {zone} - no valid data")
        return None

    print(f"  Built {len(X)} training sequences ({X.shape})")

    # Split data
    split_idx = int(len(X) * 0.8)
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]

    print(f"  Training: {len(X_train)}, Validation: {len(X_val)}")

    # Build and train model
    model = build_model(SEQUENCE_LENGTH, FEATURES_PER_TIMESTEP)

    early_stop = keras.callbacks.EarlyStopping(
        monitor='val_loss',
        patience=10,
        restore_best_weights=True
    )

    history = model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=epochs,
        batch_size=64,
        callbacks=[early_stop],
        verbose=1
    )

    # Evaluate
    val_loss, val_mae = model.evaluate(X_val, y_val, verbose=0)
    print(f"  Validation Loss: {val_loss:.4f}, MAE: {val_mae:.4f}")

    # Export
    output_path = os.path.join(output_dir, f"lstm_{zone}.json")
    os.makedirs(output_dir, exist_ok=True)

    metrics = {
        "val_loss": float(val_loss),
        "val_mae": float(val_mae),
        "epochs_trained": len(history.history['loss']),
        "training_samples": len(X_train),
        "validation_samples": len(X_val)
    }

    export_model_weights(model, output_path, zone, metrics)

    return metrics


def main():
    parser = argparse.ArgumentParser(description='Train LSTM demand correction models')
    parser.add_argument('--zone', type=str, help='Zone to train (e.g., 01NLUZ)')
    parser.add_argument('--all', action='store_true', help='Train all zones')
    parser.add_argument('--demand', type=str, default='Data Samples/Demand',
                        help='Demand data directory')
    parser.add_argument('--weather', type=str, default='weather_cache',
                        help='Weather cache directory')
    parser.add_argument('--output', type=str, default='models/lstm',
                        help='Output directory for model weights')
    parser.add_argument('--epochs', type=int, default=50, help='Training epochs')

    args = parser.parse_args()

    print("=" * 60)
    print("LSTM Demand Correction Trainer (TensorFlow)")
    print("=" * 60)
    print(f"TensorFlow version: {tf.__version__}")
    print(f"GPU available: {len(tf.config.list_physical_devices('GPU')) > 0}")

    if args.all:
        zones = ZONES
    elif args.zone:
        zones = [args.zone]
    else:
        print("Error: Specify --zone or --all")
        sys.exit(1)

    # Create output directory
    os.makedirs(args.output, exist_ok=True)

    results = {}
    for zone in zones:
        metrics = train_zone(zone, args.demand, args.weather, args.output, args.epochs)
        if metrics:
            results[zone] = metrics

    print("\n" + "=" * 60)
    print("Training Complete")
    print("=" * 60)

    for zone, metrics in results.items():
        print(f"  {zone}: MAE={metrics['val_mae']:.4f}, Loss={metrics['val_loss']:.4f}")

    # Save summary
    summary_path = os.path.join(args.output, "training_summary.json")
    with open(summary_path, 'w') as f:
        json.dump({
            "zones": results,
            "trained_at": datetime.now().isoformat(),
            "total_zones": len(results)
        }, f, indent=2)

    print(f"\nSummary saved to {summary_path}")


if __name__ == '__main__':
    main()
