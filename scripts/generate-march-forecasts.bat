@echo off
REM ============================================================================
REM Vantage Forecaster - March 2026 Forecast Generator
REM ============================================================================
REM This script generates all forecasts for March 2026:
REM   1. Zonal Demand (14 zones)
REM   2. Regional Demand (3 regions - aggregated from zonal)
REM   3. Capacity Factor (120 stations - wind, solar, hydro, etc.)
REM
REM Prerequisites:
REM   - Node.js installed
REM   - Project built (npm run build)
REM   - Training data in "Data Samples/Demand" and "Data Samples/Capacity Factor"
REM
REM Usage: generate-march-forecasts.bat
REM ============================================================================

setlocal enabledelayedexpansion

REM Configuration
set START_DATE=2026-03-01
set END_DATE=2026-03-31
set OUTPUT_DIR=output
set TRAIN_DAYS=90

REM Create output directory
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo ============================================================================
echo  Vantage Forecaster - March 2026 Forecast Generator
echo ============================================================================
echo.
echo  Forecast Period: %START_DATE% to %END_DATE%
echo  Training Window: %TRAIN_DAYS% days
echo  Output Directory: %OUTPUT_DIR%
echo.
echo ============================================================================
echo.

REM ============================================================================
REM 1. ZONAL DEMAND FORECAST (14 zones)
REM ============================================================================
echo [1/3] Generating Zonal Demand Forecast...
echo       Zones: 01NLUZ, 02METRO, 03SLUZ, 04LEYTE, 05CEBU, 06NEGROS,
echo              07BOHOL, 08PANAY, 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN,
echo              13SEMIN, 14SWMIN
echo.

set NODE_OPTIONS=--max-old-space-size=16384
node dist/index.js v1:forecast ^
  -d "Data Samples/Demand" ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv" ^
  --model hybrid ^
  --train-days %TRAIN_DAYS% ^
  --zonal

if %ERRORLEVEL% neq 0 (
    echo       [ERROR] Zonal demand forecast failed!
    goto :error
)
echo       [SUCCESS] Zonal demand saved to: %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM 2. REGIONAL DEMAND FORECAST (aggregate from zonal)
REM ============================================================================
echo [2/3] Aggregating to Regional Demand Forecast...
echo       Regions: CLUZ (Luzon), CVIS (Visayas), CMIN (Mindanao)
echo.

node -e "const fs=require('fs');const csv=fs.readFileSync('%OUTPUT_DIR%/demand_zonal_%START_DATE%_%END_DATE%.csv','utf-8');const lines=csv.trim().split('\n');const header='DateTimeEnding,CLUZ,CVIS,CMIN';const output=[header];const CLUZ=['01NLUZ','02METRO','03SLUZ'];const CVIS=['04LEYTE','05CEBU','06NEGROS','07BOHOL','08PANAY'];const CMIN=['09NWMIN','10LANAO','11NCMIN','12NEMIN','13SEMIN','14SWMIN'];const hdr=lines[0].split(',');const idx=c=>hdr.indexOf(c);for(let i=1;i<lines.length;i++){const c=lines[i].split(',');const cluz=CLUZ.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);const cvis=CVIS.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);const cmin=CMIN.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);output.push([c[0],cluz.toFixed(1),cvis.toFixed(1),cmin.toFixed(1)].join(','));}fs.writeFileSync('%OUTPUT_DIR%/demand_regional_%START_DATE%_%END_DATE%.csv',output.join('\n'));console.log('Aggregated '+output.length+' rows');"

if %ERRORLEVEL% neq 0 (
    echo       [ERROR] Regional aggregation failed!
    goto :error
)
echo       [SUCCESS] Regional demand saved to: %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM 3. CAPACITY FACTOR FORECAST (Wind + Solar + Hydro + Other)
REM ============================================================================
echo [3/3] Generating Capacity Factor Forecast...
echo       Wind: 4-Tier MREC Hybrid (6 stations)
echo       Solar: Physics+ML Hybrid (51 stations)
echo       Hydro/Geo/Bio/Battery: Profile-based (63 stations)
echo.

node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv" ^
  --auto-calibrate 14

if %ERRORLEVEL% neq 0 (
    echo       [ERROR] Capacity factor forecast failed!
    goto :error
)
echo       [SUCCESS] CFAC saved to: %OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM COMPLETE
REM ============================================================================
echo ============================================================================
echo  ALL FORECASTS COMPLETED SUCCESSFULLY
echo ============================================================================
echo.
echo  Output files:
echo    - %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv     (14 zones)
echo    - %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv  (3 regions)
echo    - %OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv             (120 stations)
echo.
echo ============================================================================
goto :end

:error
echo.
echo ============================================================================
echo  FORECAST GENERATION FAILED - Check error messages above
echo ============================================================================
echo.
echo  Common issues:
echo    1. Out of memory - Increase NODE_OPTIONS or reduce --train-days
echo    2. Missing data - Check "Data Samples" folders have CSV files
echo    3. Build needed - Run: npm run build
echo.
exit /b 1

:end
endlocal
