@echo off
REM Run scaled zonal demand forecast with per-zone bias correction

set NODE_OPTIONS=--max-old-space-size=16384

echo Running zonal demand forecast with per-zone scaling...
echo.

node dist/index.js v1:forecast ^
  -d "Data Samples/Demand" ^
  -s 2026-03-01 ^
  -e 2026-03-31 ^
  -o output/demand_zonal_scaled_2026-03.csv ^
  --model hybrid ^
  --zonal ^
  --train-days 60 ^
  --scale-zone "01NLUZ:-10,02METRO:-22,03SLUZ:-16,04LEYTE:-28,05CEBU:-8,06NEGROS:9,07BOHOL:-1,08PANAY:-10,09NWMIN:-1,10LANAO:-6,11NCMIN:-11,12NEMIN:-6,13SEMIN:1,14SWMIN:5"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Forecast failed!
    exit /b 1
)

echo.
echo [SUCCESS] Scaled zonal forecast saved to output/demand_zonal_scaled_2026-03.csv
