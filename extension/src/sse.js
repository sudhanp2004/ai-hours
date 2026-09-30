// Incremental Server-Sent Events framer. Knows nothing about any site.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  ns.createSseParser = function createSseParser(onEvent) {
    let buf = '';

    function emit(block) {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ event, data: data.join('\n') });
    }

    function drain() {
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        emit(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }

    return {
      push(text) {
        buf += text;
        // Hold back a trailing \r: it may be the first half of a \r\n split across chunks.
        const tail = buf.endsWith('\r') ? '\r' : '';
        buf = buf.slice(0, buf.length - tail.length).replace(/\r\n?/g, '\n');
        drain();
        buf += tail;
      },
      end() {
        buf = buf.replace(/\r\n?/g, '\n');
        drain();
        if (buf.trim()) emit(buf);
        buf = '';
      },
    };
  };
})(globalThis);
