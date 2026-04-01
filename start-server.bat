@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   SCI-ACE - Khởi động Backend Server
echo ========================================
echo.
echo Đang chạy server tại http://localhost:3000
echo.
echo Mở trình duyệt: http://localhost:3000
echo Hoặc trang Đặt lại mật khẩu: http://localhost:3000/dat-lai-mat-khau.html
echo.
echo GIỮ CỬA SỔ NÀY MỞ để server chạy.
echo Nhấn Ctrl+C để dừng server.
echo ========================================
echo.
node server.js
pause
