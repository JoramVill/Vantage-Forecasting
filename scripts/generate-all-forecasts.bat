@echo off
REM ============================================================================
REM Vantage Forecaster - Complete Forecast Generator
REM ============================================================================
REM Generates all forecast types (Demand + Capacity Factor) for any date range.
REM
REM Usage:
REM   generate-all-forecasts.bat                     (defaults: tomorrow to +7 days)
REM   generate-all-forecasts.bat 2026-04-01 2026-04-30   (custom dates)
REM
REM Output files saved to: output/
REM ============================================================================

setlocal enabledelayedexpansion

REM Parse command line arguments or set defaults
set START_DATE=%1
set END_DATE=%2

if "%START_DATE%"=="" (
    for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(1).ToString('yyyy-MM-dd')"') do set START_DATE=%%i
)
if "%END_DATE%"=="" (
    for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(8).ToString('yyyy-MM-dd')"') do set END_DATE=%%i
)

REM Configuration
set OUTPUT_DIR=output
set TRAIN_DAYS=90

REM Create output directory
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo ============================================================================
echo  Vantage Forecaster - Complete Forecast Generator
echo ============================================================================
echo.
echo  Forecast Period: %START_DATE% to %END_DATE%
echo  Training Window: %TRAIN_DAYS% days
echo  Output Directory: %OUTPUT_DIR%
echo.
echo  This will generate:
echo    1. Zonal Demand Forecast (14 zones)
echo    2. Regional Demand Forecast (3 regions)
echo    3. Capacity Factor Forecast (120 stations)
echo.
echo ============================================================================
echo.
echo  Press any key to continue or Ctrl+C to cancel...
pause > nul
echo.

REM Set memory limit for Node.js
set NODE_OPTIONS=--max-old-space-size=16384

REM ============================================================================
REM STEP 1: ZONAL DEMAND FORECAST
REM ============================================================================
echo.
echo [STEP 1/3] Generating Zonal Demand Forecast...
echo ============================================================================
echo.

node dist/index.js v1:forecast ^
  -d "Data Samples/Demand" ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv" ^
  --model hybrid ^
  --train-days %TRAIN_DAYS% ^
  --zonal

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Zonal demand forecast failed!
    echo.
    goto :error
)

echo.
echo [SUCCESS] Zonal demand forecast complete!
echo    Output: %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM STEP 2: AGGREGATE TO REGIONAL
REM ============================================================================
echo.
echo [STEP 2/3] Aggregating Zonal to Regional Demand...
echo ============================================================================
echo.

node -e "const fs=require('fs');const csv=fs.readFileSync('%OUTPUT_DIR%/demand_zonal_%START_DATE%_%END_DATE%.csv','utf-8');const lines=csv.trim().split('\n');const header='DateTimeEnding,CLUZ,CVIS,CMIN';const output=[header];const CLUZ=['01NLUZ','02METRO','03SLUZ'];const CVIS=['04LEYTE','05CEBU','06NEGROS','07BOHOL','08PANAY'];const CMIN=['09NWMIN','10LANAO','11NCMIN','12NEMIN','13SEMIN','14SWMIN'];const hdr=lines[0].split(',');const idx=c=>hdr.indexOf(c);for(let i=1;i<lines.length;i++){const c=lines[i].split(',');const cluz=CLUZ.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);const cvis=CVIS.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);const cmin=CMIN.reduce((s,z)=>s+parseFloat(c[idx(z)]||0),0);output.push([c[0],cluz.toFixed(1),cvis.toFixed(1),cmin.toFixed(1)].join(','));}fs.writeFileSync('%OUTPUT_DIR%/demand_regional_%START_DATE%_%END_DATE%.csv',output.join('\n'));console.log('Aggregated '+(output.length-1)+' hourly rows to 3 regions');"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Regional aggregation failed!
    echo.
    goto :error
)

echo.
echo [SUCCESS] Regional demand forecast complete!
echo    Output: %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM STEP 3: CAPACITY FACTOR FORECAST
REM ============================================================================
echo.
echo [STEP 3/3] Generating Capacity Factor Forecast...
echo ============================================================================
echo.

node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv" ^
  --auto-calibrate 14

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Capacity factor forecast failed!
    echo.
    goto :error
)

echo.
echo [SUCCESS] Capacity factor forecast complete!
echo    Output: %OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM SUMMARY
REM ============================================================================
echo.
echo ============================================================================
echo  ALL FORECASTS COMPLETED SUCCESSFULLY
echo ============================================================================
echo.
echo  Generated files:
echo.
echo    DEMAND FORECASTS:
echo      Zonal (14 zones):    %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv
echo      Regional (3 regions): %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv
echo.
echo    CAPACITY FACTOR:
echo      All stations (120):   %OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv
echo.
echo  Zone/Region Mapping:
echo    CLUZ (Luzon)    = 01NLUZ + 02METRO + 03SLUZ
echo    CVIS (Visayas)  = 04LEYTE + 05CEBU + 06NEGROS + 07BOHOL + 08PANAY
echo    CMIN (Mindanao) = 09NWMIN + 10LANAO + 11NCMIN + 12NEMIN + 13SEMIN + 14SWMIN
echo.
echo ============================================================================
goto :end

:error
echo.
echo ============================================================================
echo  FORECAST GENERATION FAILED
echo ============================================================================
echo.
echo  Troubleshooting:
echo.
echo    1. OUT OF MEMORY
echo       - The script uses 16GB heap. Your PC may need more RAM.
echo       - Try reducing TRAIN_DAYS in this script (edit line 22).
echo.
echo    2. MISSING TRAINING DATA
echo       - Check "Data Samples/Demand" folder has DemHr_*.csv files
echo       - Check "Data Samples/Capacity Factor" has MRHCFac_*.csv files
echo.
echo    3. BUILD NOT DONE
echo       - Run: npm run build
echo.
echo    4. NODE.JS NOT INSTALLED
echo       - Install Node.js 18+ from https://nodejs.org
echo.
exit /b 1

:end
endlocal
