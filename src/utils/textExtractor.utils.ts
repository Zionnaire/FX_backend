import pdfParse from 'pdf-parse';

export async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  try {
    if (mimetype === 'text/plain' || mimetype === 'text/csv') {
      return buffer.toString('utf-8');
    }
    
    if (mimetype === 'application/json') {
      const json = JSON.parse(buffer.toString('utf-8'));
      return JSON.stringify(json, null, 2);
    }
    
    if (mimetype === 'application/pdf') {
      const data = await pdfParse(buffer);
      return data.text;
    }
    
    return buffer.toString('utf-8');
  } catch (error) {
    console.error(`Error extracting text from ${mimetype}:`, error);
    return buffer.toString('utf-8');
  }
}
