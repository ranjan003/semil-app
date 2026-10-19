# Regenerates the real Excel/Word fixtures used by test/qb_import.test.js (needs openpyxl and python-docx).
import openpyxl, docx, zipfile, os, sys
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qb'); os.makedirs(out, exist_ok=True)
H = ['Question ID','Question Text','Type','Option A','Option B','Option C','Option D','Correct Answer','Explanation','Difficulty','Job Role','Round','Category','Marks','Negative Marks','Status']
rows = [
 ['', 'What is 15% of 200?', 'MCQ', '20','30','40','25','B','', 'Easy','', 1,'Aptitude',1,0.25,''],
 ['EXT-2', 'Select the prime numbers.', 'Multi Select', '2','4','5','9','A, C','Primes have two divisors.', 'Medium','SDE','Round 2','Technical',2,0.5,'Active'],
 ['', 'Explain normalisation in databases.', 'Descriptive','','','','','Remove redundancy; 1NF-3NF','', 'Hard','sde',3,'Databases',5,'','inactive'],
 ['', 'Bad row: no answer', 'mcq','x','y','','','','', 'easy','',1,'Aptitude',1,0,''],
 ['', 'Bad row: marks zero here', 'mcq','x','y','','','A','', 'easy','',1,'Aptitude',0,0,''],
 ['', 'What is 15% of 200?', 'mcq','1','2','','','A','', 'easy','',1,'Aptitude',1,0,''],   # duplicate of row 2
]
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Questions'; ws.append(H)
for r in rows: ws.append(r)
wb.create_sheet('Notes').append(['ignore me'])
wb.save(f'{out}/valid.xlsx')
wf = openpyxl.Workbook(); w = wf.active; w.title = 'Questions'; w.append(H)
w.append(['', 'Formula cell question text', 'mcq', '=1+1', 'b', '', '', 'A', '', 'easy', '', 1, 'Aptitude', 1, 0, ''])
wf.save(f'{out}/formula.xlsx')
d = docx.Document(); d.add_paragraph('My questions'); t = d.add_table(rows=1, cols=len(H)); 
for i,h in enumerate(H): t.rows[0].cells[i].text = h
for r in rows[:3]:
    c = t.add_row().cells
    for i,v in enumerate(r): c[i].text = str(v)
d.save(f'{out}/valid.docx')
d2 = docx.Document(); d2.add_paragraph('no table here'); d2.save(f'{out}/notable.docx')
with open(f'{out}/win1252.csv','wb') as f:
    f.write('question_text,question_type,option_a,option_b,correct_answer,difficulty,round,topic,marks\r\nCaf\xe9 menu: which is a hot drink?,mcq,Caf\xe9 au lait,Ice,A,easy,1,General,1\r\n'.encode('cp1252'))
# zip bomb: 30 MB of zeros inside a small xlsx-looking archive
with zipfile.ZipFile(f'{out}/bomb.xlsx','w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('xl/workbook.xml','<workbook/>'); z.writestr('xl/worksheets/sheet1.xml','0'*(45*1024*1024))
print('fixtures written to', out)
