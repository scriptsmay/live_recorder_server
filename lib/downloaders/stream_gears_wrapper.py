import sys, json
from stream_gears import download, PySegment

if __name__ == '__main__':
    config = json.loads(sys.argv[1])
    segment = config['segment']
    seg = PySegment()
    if 'Time' in segment:
        seg.time = segment['Time']['time']
    else:
        seg.size = segment['Size']['size']
    download(config['url'], config.get('headers', {}), config['file_name'], seg)
