#!/usr/bin/env python3
# -*- encoding: utf-8 -*-

import argparse
import asyncio
import base64
import hashlib
import json
import random
import re
import signal
import subprocess
import sys
import time
import urllib.parse
import os

try:
    import httpx
except ImportError:
    print("Error: httpx is required. Install it with: pip install httpx")
    sys.exit(1)


QUALITY_MAPPING = {"OD": 0, "BD": 0, "UHD": 1, "HD": 2, "SD": 3, "LD": 4}


def get_quality_index(quality):
    if not quality:
        return list(QUALITY_MAPPING.items())[0]
    
    quality_str = str(quality).upper()
    if quality_str.isdigit():
        quality_int = int(quality_str[0])
        quality_str = list(QUALITY_MAPPING.keys())[quality_int]
    return quality_str, QUALITY_MAPPING.get(quality_str, 0)


def get_anti_code(old_anti_code, stream_name):
    params_t = 100
    sdk_version = 2403051612
    t13 = int(time.time()) * 1000
    sdk_sid = t13
    
    init_uuid = (int(t13 % 10 ** 10 * 1000) + int(1000 * random.random())) % 4294967295
    uid = random.randint(1400000000000, 1400009999999)
    seq_id = uid + sdk_sid
    
    target_unix_time = (t13 + 110624) // 1000
    ws_time = f"{target_unix_time:x}".lower()
    
    url_query = urllib.parse.parse_qs(old_anti_code)
    ws_secret_pf = base64.b64decode(urllib.parse.unquote(url_query['fm'][0]).encode()).decode().split("_")[0]
    ws_secret_hash = hashlib.md5(f'{seq_id}|{url_query["ctype"][0]}|{params_t}'.encode()).hexdigest()
    ws_secret = f'{ws_secret_pf}_{uid}_{stream_name}_{ws_secret_hash}_{ws_time}'
    ws_secret_md5 = hashlib.md5(ws_secret.encode()).hexdigest()
    
    anti_code = (
        f'wsSecret={ws_secret_md5}&wsTime={ws_time}&seqid={seq_id}&ctype={url_query["ctype"][0]}&ver=1'
        f'&fs={url_query["fs"][0]}&uuid={init_uuid}&u={uid}&t={params_t}&sv={sdk_version}'
        f'&sdk_sid={sdk_sid}&codec=264'
    )
    return anti_code


async def get_huya_stream_data(url, proxy_addr=None):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
    }

    async with httpx.AsyncClient(proxy=proxy_addr, timeout=30) as client:
        html_str = await client.get(url, headers=headers)
        json_str = re.findall('stream: (\\{"data".*?),"iWebDefaultBitRate"', html_str.text)[0]
        json_data = json.loads(json_str + '}')
        return json_data


async def get_huya_app_stream_url(url, proxy_addr=None):
    headers = {
        'User-Agent': 'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A3089/A3090/A3092))',
        'xweb_xhr': '1',
        'referer': 'https://servicewechat.com/wx74767bf0b684f7d3/301/page-frame.html',
        'accept-language': 'zh-CN,zh;q=0.9',
    }

    room_id = url.split('?')[0].rsplit('/', maxsplit=1)[-1]

    if any(char.isalpha() for char in room_id):
        web_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
        async with httpx.AsyncClient(proxy=proxy_addr, timeout=30) as client:
            html_str = await client.get(url, headers=web_headers)
            room_data_match = re.search(r'var\s+TT_ROOM_DATA\s*=\s*(.*?);', html_str.text)
            if room_data_match:
                try:
                    room_data = json.loads(room_data_match.group(1))
                    if room_data.get('profileRoom'):
                        room_id = str(room_data['profileRoom'])
                    else:
                        raise Exception('Please use "https://www.huya.com/+room_number" for recording')
                except json.JSONDecodeError:
                    raise Exception('Please use "https://www.huya.com/+room_number" for recording')
            else:
                raise Exception('Please use "https://www.huya.com/+room_number" for recording')

    params = {
        'm': 'Live',
        'do': 'profileRoom',
        'roomid': room_id,
        'showSecret': '1',
    }
    wx_app_api = f'https://mp.huya.com/cache.php?{urllib.parse.urlencode(params)}'

    async with httpx.AsyncClient(proxy=proxy_addr, timeout=30) as client:
        json_str = await client.get(wx_app_api, headers=headers)
        json_data = json_str.json()
        anchor_name = json_data['data']['profileInfo']['nick']
        live_status = json_data['data']['realLiveStatus']
        live_title = json_data['data']['liveData']['introduction']
        if live_status != 'ON':
            return {'anchor_name': anchor_name, 'is_live': False}
        else:
            base_steam_info_list = json_data['data']['stream']['baseSteamInfoList']
            play_url_list = []
            for i in base_steam_info_list:
                cdn_type = i['sCdnType']
                stream_name = i['sStreamName']
                s_flv_url = i['sFlvUrl']
                flv_anti_code = i['sFlvAntiCode']
                s_hls_url = i['sHlsUrl']
                hls_anti_code = i['sHlsAntiCode']
                m3u8_url = f'{s_hls_url}/{stream_name}.m3u8?{hls_anti_code}'
                flv_url = f'{s_flv_url}/{stream_name}.flv?{flv_anti_code}'
                play_url_list.append({
                    'cdn_type': cdn_type,
                    'm3u8_url': m3u8_url,
                    'flv_url': flv_url,
                })

            priority_order = ["TX", "HW", "HS", "AL"]
            selected_flv_url = None
            selected_cdn_type = None

            for cdn in priority_order:
                for item in play_url_list:
                    if item["cdn_type"] == cdn:
                        selected_flv_url = item["flv_url"]
                        selected_cdn_type = cdn
                        break
                if selected_flv_url:
                    break

            if selected_flv_url:
                flv_url = 'https://' + selected_flv_url.split('://')[1]
                if selected_cdn_type == "TX":
                    flv_url = flv_url.replace("&ctype=tars_mp", "&ctype=huya_webh5").replace("&fs=bhct", "&fs=bgct")
                record_url = flv_url
            else:
                record_url = None

            return {
                'anchor_name': anchor_name,
                'is_live': True,
                'm3u8_url': play_url_list[0]['m3u8_url'],
                'flv_url': play_url_list[0]['flv_url'],
                'record_url': record_url,
                'title': live_title
            }


async def get_huya_stream_url(url, video_quality, proxy_addr=None):
    if video_quality in ["OD", "BD", "UHD"]:
        stream_data = await get_huya_app_stream_url(url, proxy_addr)
    else:
        try:
            json_data = await get_huya_stream_data(url, proxy_addr)
            game_live_info = json_data['data'][0]['gameLiveInfo']
            live_title = game_live_info['introduction']
            stream_info_list = json_data['data'][0]['gameStreamInfoList']
            anchor_name = game_live_info.get('nick', '')
            
            if not stream_info_list:
                return {'anchor_name': anchor_name, 'is_live': False}
            
            select_cdn = stream_info_list[0]
            flv_url = select_cdn.get('sFlvUrl')
            stream_name = select_cdn.get('sStreamName')
            flv_url_suffix = select_cdn.get('sFlvUrlSuffix')
            hls_url = select_cdn.get('sHlsUrl')
            hls_url_suffix = select_cdn.get('sHlsUrlSuffix')
            flv_anti_code = select_cdn.get('sFlvAntiCode')
            
            new_anti_code = get_anti_code(flv_anti_code, stream_name)
            flv_url = f'{flv_url}/{stream_name}.{flv_url_suffix}?{new_anti_code}&ratio='
            m3u8_url = f'{hls_url}/{stream_name}.{hls_url_suffix}?{new_anti_code}&ratio='
            
            quality_list = flv_anti_code.split('&exsphd=')
            if len(quality_list) > 1 and video_quality not in ["OD", "BD"]:
                pattern = r"(?<=264_)\d+"
                quality_list = list(re.findall(pattern, quality_list[1]))[::-1]
                while len(quality_list) < 5:
                    quality_list.append(quality_list[-1])
                
                video_quality_options = {
                    "UHD": quality_list[0],
                    "HD": quality_list[1],
                    "SD": quality_list[2],
                    "LD": quality_list[3]
                }
                
                if video_quality not in video_quality_options:
                    raise ValueError(f"Invalid video quality. Available options are: {', '.join(video_quality_options.keys())}")
                
                flv_url = flv_url + str(video_quality_options[video_quality])
                m3u8_url = m3u8_url + str(video_quality_options[video_quality])
            
            stream_data = {
                'is_live': True,
                'title': live_title,
                'quality': video_quality,
                'm3u8_url': m3u8_url,
                'flv_url': flv_url,
                'record_url': flv_url or m3u8_url,
                'anchor_name': anchor_name
            }
        except Exception as e:
            print(f"Failed to get huya stream data from web, trying app API: {e}")
            stream_data = await get_huya_app_stream_url(url, proxy_addr)
    
    return stream_data


class HuyaRecorder:
    def __init__(self, url, output_path, quality='UHD', segment_duration=0, max_retries=30):
        self.url = url
        self.output_path = output_path
        self.quality = quality
        self.segment_duration = segment_duration
        self.max_retries = max_retries
        self.retry_count = 0
        self.process = None
        self.running = True
        self.last_reconnect_time = 0
        self.min_reconnect_interval = 5
        
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
    
    def signal_handler(self, sig, frame):
        print("\n[录制器] 收到停止信号，正在安全停止 FFmpeg...")
        self.running = False
        if self.process:
            try:
                self.process.send_signal(signal.SIGINT)
            except Exception:
                pass
    
    async def get_stream_url(self):
        while self.running and self.retry_count < self.max_retries:
            if not self.running:
                return None
            
            try:
                stream_data = await get_huya_stream_url(self.url, self.quality)
                if not self.running:
                    return None
                    
                if stream_data.get('is_live') and stream_data.get('record_url'):
                    self.retry_count = 0
                    return stream_data['record_url']
                else:
                    print(f"[录制器] 直播未开始或无流地址，等待重试 ({self.retry_count}/{self.max_retries})")
            except Exception as e:
                print(f"[录制器] 获取流地址失败: {e}")
            
            self.retry_count += 1
            await asyncio.sleep(min(5 * self.retry_count, 30))
        
        return None
    
    def build_ffmpeg_cmd(self, record_url):
        # 伪装 Mac 浏览器的 UA，防止 Huya CDN 因为认出 Lavf (FFmpeg) 返回 403 从而退出
        user_agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        
        ffmpeg_cmd = [
            'ffmpeg', '-y',
            '-loglevel', 'error',               # 只输出错误信息，避免刷屏，但也防止排错时瞎子摸象
            '-user_agent', user_agent,          # 关键突破口
            '-rw_timeout', '15000000',          # 15秒读写超时
            '-reconnect', '1',                  
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '10',
            '-i', record_url,
            '-c', 'copy',
            '-fflags', '+genpts+igndts+discardcorrupt',
            '-correct_ts_overflow', '1',
            '-avoid_negative_ts', '1',
            '-thread_queue_size', '1024',
            '-max_muxing_queue_size', '1024'
        ]

        if self.segment_duration > 0:
            base, ext = os.path.splitext(self.output_path)
            segment_pattern = f"{base}_{ext}"
            ffmpeg_cmd.extend([
                '-f', 'segment',
                '-segment_time', str(self.segment_duration),
                '-segment_format', 'mp4' if ext.lower() == '.mp4' else 'mpegts',
                '-reset_timestamps', '1',
                '-strftime', '1', 
                f"{base}_%Y%m%d_%H%M%S{ext}"
            ])
        else:
            ffmpeg_cmd.append(self.output_path)
            
        return ffmpeg_cmd
    
    def run_ffmpeg(self, record_url):
        # 自动创建目标文件的父级目录，防止因为测试路径不存在导致 FFmpeg(代码8) 报错
        os.makedirs(os.path.dirname(os.path.abspath(self.output_path)), exist_ok=True)
        
        ffmpeg_cmd = self.build_ffmpeg_cmd(record_url)
        print(f"[FFmpeg] 启动命令: {' '.join(ffmpeg_cmd)}")
        
        # 将 stderr 放出来映射到 sys.stderr，如果有报错直接在控制台展示
        self.process = subprocess.Popen(
            ffmpeg_cmd, 
            stdin=subprocess.PIPE, 
            stdout=subprocess.DEVNULL, 
            stderr=sys.stderr 
        )
        
        exit_code = self.process.wait()
        return exit_code
    
    async def run(self):
        print(f"[录制器] 开始录制虎牙直播: {self.url}")
        print(f"[录制器] 输出配置: {self.output_path}")
        print(f"[录制器] 画质: {self.quality}")
        
        while self.running:
            current_time = time.time()
            if current_time - self.last_reconnect_time < self.min_reconnect_interval:
                await asyncio.sleep(self.min_reconnect_interval - (current_time - self.last_reconnect_time))
            
            record_url = await self.get_stream_url()
            if not record_url:
                print("[录制器] 无法获取流地址或达到重试上限，录制退出。")
                return 1 if self.running else 0
            
            print(f"[录制器] 获取到流地址，开始推给 FFmpeg 录制...")
            self.last_reconnect_time = time.time()
            
            try:
                exit_code = self.run_ffmpeg(record_url)
                print(f"[录制器] FFmpeg 进程退出，代码: {exit_code}")
                
                if not self.running:
                    print("[录制器] 用户主动停止，录制正常结束。")
                    return 0
                
                self.retry_count += 1
                if self.retry_count >= self.max_retries:
                    print(f"[录制器] 连续异常退出次数达到上限 ({self.max_retries})，停止录制。")
                    return 1
                
                wait_time = min(2 * self.retry_count, 20)
                print(f"[录制器] 流断开，等待 {wait_time} 秒后尝试重新获取流并续录...")
                await asyncio.sleep(wait_time)
                
            except Exception as e:
                print(f"[录制器] 运行异常: {e}")
                self.retry_count += 1
                await asyncio.sleep(5)
        
        return 0


def main():
    parser = argparse.ArgumentParser(description='Huya Live Recorder (No Temp Files)')
    parser.add_argument('--url', required=True, help='Huya live room URL')
    parser.add_argument('--output', required=True, help='Output file path')
    parser.add_argument('--quality', default='UHD', help='Video quality (OD/BD/UHD/HD/SD/LD)')
    parser.add_argument('--segment-duration', type=int, default=0, help='Segment duration in seconds (0 for single file)')
    parser.add_argument('--max-retries', type=int, default=30, help='Maximum number of reconnect attempts')
    args = parser.parse_args()

    try:
        recorder = HuyaRecorder(
            url=args.url,
            output_path=args.output,
            quality=args.quality,
            segment_duration=args.segment_duration,
            max_retries=args.max_retries
        )
        return asyncio.run(recorder.run())
    except Exception as e:
        print(f"[错误] {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())