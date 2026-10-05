# WAF Security Operations Center - BP Batam

Dashboard monitoring untuk WAF (Web Application Firewall) BP Batam.
Menarik data langsung dari Kibana/Elasticsearch.

## Cara Menjalankan

### Persyaratan
- Python 3.10+
- Akses jaringan ke Kibana BP Batam

### Langkah Cepat (Windows)
1. Double-click `run.bat`
2. Buka browser: http://localhost:5000

### Langkah Manual
```cmd
cd nama_folder / contoh:(cd C:\laragon\www\waf-dashboard\backend)
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py