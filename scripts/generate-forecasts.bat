@echo off
REM ============================================================================
REM Vantage Forecaster - Batch Forecast Generator (V2 Architecture)
REM ============================================================================
REM This script generates demand (regional + zonal) and capacity factor forecasts.
REM Uses V2 Level x Shape architecture for demand forecasting.
REM
REM Usage: generate-forecasts.bat [START_DATE] [END_DATE]
REM   START_DATE - Forecast start date (YYYY-MM-DD), default: tomorrow
REM   END_DATE   - Forecast end date (YYYY-MM-DD), default: +7 days
REM
REM Output files are saved to: output/forecasts/
REM ============================================================================

setlocal enabledelayedexpansion

REM Set default dates if not provided (using PowerShell for date calculation)
set START_DATE=%1
set END_DATE=%2

if "%START_DATE%"=="" (
    for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(1).ToString('yyyy-MM-dd')"') do set START_DATE=%%i
)
if "%END_DATE%"=="" (
    for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(8).ToString('yyyy-MM-dd')"') do set END_DATE=%%i
)

REM Create output directory
set OUTPUT_DIR=output\forecasts
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo ============================================================================
echo  Vantage Forecaster - Batch Forecast Generator (V2)
echo ============================================================================
echo.
echo  Forecast Period: %START_DATE% to %END_DATE%
echo  Output Directory: %OUTPUT_DIR%
echo  Architecture: V2 Level x Shape
echo.
echo ============================================================================
echo.

REM ============================================================================
REM 1. REGIONAL DEMAND FORECAST (V2 - 3 regions: CLUZ, CVIS, CMIN)
REM ============================================================================
echo [1/3] Generating Regional Demand Forecast (V2)...
echo       Regions: CLUZ (Luzon), CVIS (Visayas), CMIN (Mindanao)
echo       Architecture: Level Model (daily total) x Shape Model (24h profile)
echo.

node dist/index.js forecast ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv" ^
  --verbose

if %ERRORLEVEL% neq 0 (
    echo       [ERROR] Regional demand forecast failed!
    echo       TIP: Ensure you have trained a V2 model with: v2:train
    goto :error
)
echo       [SUCCESS] Regional demand saved to: %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM 2. ZONAL DEMAND FORECAST (V2 - 14 sub-regions)
REM ============================================================================
echo [2/3] Generating Zonal Demand Forecast (V2)...
echo       Zones: 01NLUZ, 02METRO, 03SLUZ, 04LEYTE, 05CEBU, 06NEGROS,
echo              07BOHOL, 08PANAY, 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN,
echo              13SEMIN, 14SWMIN
echo.

node dist/index.js forecast ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv" ^
  --zonal ^
  --verbose

if %ERRORLEVEL% neq 0 (
    echo       [ERROR] Zonal demand forecast failed!
    echo       TIP: Ensure you have trained a zonal V2 model with: v2:train --zonal
    goto :error
)
echo       [SUCCESS] Zonal demand saved to: %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv
echo.

REM ============================================================================
REM 3. CAPACITY FACTOR FORECAST (Wind + Solar)
REM ============================================================================
echo [3/3] Generating Capacity Factor Forecast (Wind + Solar)...
echo       Models: 4-Tier Hybrid (Wind), Physics+ML Hybrid (Solar)
echo.

node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s %START_DATE% ^
  -e %END_DATE% ^
  -o "%OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv"

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
echo    - %OUTPUT_DIR%\demand_regional_%START_DATE%_%END_DATE%.csv
echo    - %OUTPUT_DIR%\demand_zonal_%START_DATE%_%END_DATE%.csv
echo    - %OUTPUT_DIR%\cfac_%START_DATE%_%END_DATE%.csv
echo.
echo  V2 Architecture Notes:
echo    - Demand forecasts use Level x Shape decomposition
echo    - Level Model predicts daily total from weather + calendar + lags
echo    - Shape Model predicts 24-hour profile from ProfileLibrary + adjustments
echo    - Final forecast = dailyTotal x hourlyShape
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
echo    1. No V2 model trained - Run: node dist/index.js v2:train ...
echo    2. No calibration file - Run: node dist/index.js v2:calibrate ...
echo    3. Missing training data - Check "Data Samples/Demand" folder
echo.
exit /b 1

:end
endlocal
