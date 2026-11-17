@echo off
title Menu - Braga Frame
cd /d "%~dp0"

:menu
color 0b
cls
echo ==================================================
echo              BRAGA FRAME - MENU
echo ==================================================
echo.
echo [1] Rodar o aplicativo (instala as dependencias na primeira vez)
echo [2] Rodar os testes (unitarios e de integracao)
echo [3] Rodar os testes e2e (abre o app de verdade)
echo [4] Verificar o codigo (lint)
echo [5] Gerar .zip do codigo para enviar ao Gemini/GPT
echo [0] Sair
echo.
choice /c 123450 /n /m "Escolha uma opcao: "
if errorlevel 255 exit /b 1
if errorlevel 6 goto end
if errorlevel 5 goto zip
if errorlevel 4 goto lint
if errorlevel 3 goto e2e
if errorlevel 2 goto tests
if errorlevel 1 goto run
goto menu

:checknode
where node >nul 2>nul
if errorlevel 1 (
  color 0c
  echo.
  echo Node.js nao encontrado. Instale o Node.js e tente de novo.
  pause
  goto menu
)
if not exist "node_modules\electron" (
  echo Instalando dependencias ^(npm install^)...
  call npm install
  if errorlevel 1 (
    color 0c
    echo.
    echo Falha ao instalar as dependencias.
    pause
    goto menu
  )
)
goto %retorno%

:run
set retorno=run2
goto checknode
:run2
color 0b
cls
echo Iniciando o aplicativo...
call npm start
pause
goto menu

:tests
set retorno=tests2
goto checknode
:tests2
color 0e
cls
echo Rodando os testes ^(pode levar varios minutos^)...
set BF_SKIP_NETWORK_TESTS=1
call npm test
pause
goto menu

:e2e
set retorno=e2e2
goto checknode
:e2e2
color 0e
cls
echo Rodando os testes e2e ^(abrem o aplicativo; nao use o mouse durante o teste^)...
call npm run test:e2e
pause
goto menu

:lint
set retorno=lint2
goto checknode
:lint2
color 0a
cls
echo Verificando o codigo...
call npm run lint
pause
goto menu

:zip
set retorno=zip2
goto checknode
:zip2
color 0d
cls
echo Gerando o .zip do codigo atualizado...
call node scripts\gerar-zip.js --abrir
pause
goto menu

:end
exit 0
