#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蔵書保管場所変更・記録システム ローカル＆スマホ実機検証用サーバー (start_server.py)
-------------------------------------------------------------------------
機能:
1. PCと同一Wi-Fi（LAN）内のiPhoneからアクセスできるよう 0.0.0.0 で待受し、LAN IPアドレスを自動表示します。
2. `--https` オプションを付けて起動すると、自己署名SSL証明書を一時生成し、
   iPhoneの「リアルタイム連続カメラ読取（getUserMedia）」に必要な HTTPS サーバーとして起動します。

使い方:
  通常起動 (HTTP) : python3 start_server.py
  HTTPS起動(推奨) : python3 start_server.py --https
"""

import argparse
import http.server
import os
import socket
import socketserver
import ssl
import subprocess
import tempfile
import webbrowser

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def get_lan_ip() -> str:
    """同一Wi-Fi内のスマホからアクセスするためのローカルIPアドレスを取得"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def create_self_signed_cert(lan_ip: str):
    """openssl コマンドを使って一時的な自己署名証明書を /tmp に生成（リポジトリは汚さない）"""
    cert_dir = tempfile.mkdtemp(prefix="blm_https_")
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")
    cnf_file = os.path.join(cert_dir, "openssl.cnf")

    cnf_content = f"""[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = {lan_ip}

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = {lan_ip}
IP.2 = 127.0.0.1
DNS.1 = localhost
"""
    with open(cnf_file, "w", encoding="utf-8") as f:
        f.write(cnf_content)

    cmd = [
        "openssl", "req", "-x509", "-nodes", "-days", "30",
        "-newkey", "rsa:2048",
        "-keyout", key_file,
        "-out", cert_file,
        "-config", cnf_file
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert_file, key_file


def main():
    parser = argparse.ArgumentParser(description="蔵書保管場所変更アプリ 検証用サーバー")
    parser.add_argument("--https", action="store_true", help="iPhoneカメラ連続読取用にHTTPSで起動する")
    parser.add_argument("--port", type=int, default=PORT, help="ポート番号 (既定: 8080)")
    args = parser.parse_args()

    os.chdir(BASE_DIR)
    lan_ip = get_lan_ip()
    handler = http.server.SimpleHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True

    scheme = "https" if args.https else "http"
    pc_url = f"{scheme}://localhost:{args.port}/index.html"
    phone_url = f"{scheme}://{lan_ip}:{args.port}/index.html"

    with socketserver.TCPServer(("0.0.0.0", args.port), handler) as httpd:
        if args.https:
            try:
                cert_file, key_file = create_self_signed_cert(lan_ip)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(certfile=cert_file, keyfile=key_file)
                httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
            except Exception as e:
                print(f"[警告] HTTPS証明書の生成に失敗したためHTTPで起動します: {e}")
                scheme = "http"
                pc_url = f"http://localhost:{args.port}/index.html"
                phone_url = f"http://{lan_ip}:{args.port}/index.html"

        print("=" * 72)
        print(f"📚 蔵書保管場所 変更・記録システム サーバー起動完了 ({scheme.upper()}モード)")
        print("=" * 72)
        print(f"💻 PCで開くURL        : {pc_url}")
        print(f"📱 iPhoneで開くURL    : {phone_url}")
        print("   （※PCとiPhoneを同じWi-Fiに接続して上記URLをiPhoneのEdge/Safariに入力してください）")
        if scheme == "https":
            print("\n💡 iPhoneで開いた際に「この接続ではプライバシーが保護されません」と出た場合:")
            print("   「詳細設定（または詳細を表示）」→「…にアクセスする（安全ではありません）」をタップすると")
            print("   リアルタイムのカメラ連続読取（▶️ カメラ開始）がそのまま使えます！")
        else:
            print("\n💡 iPhoneでリアルタイム連続カメラを使う場合は `python3 start_server.py --https` で起動してください。")
        print("\n終了するには Ctrl+C を押してください。")
        print("=" * 72)

        try:
            webbrowser.open(pc_url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nサーバーを停止しました。")


if __name__ == "__main__":
    main()
