"use client";
import React, { useState, useEffect } from 'react';
import CustomIcon from '../../components/CustomIcon';
import { saveDataToServer } from '@/app/lib/storageClient';

const STORAGE_KEYS = {
    PRODUCTS: 'core_lms_products_v1'
};

// Умный парсер CSV для импорта из Excel
const parseCSV = (str: string) => {
    const result = [];
    let row = [];
    let inQuotes = false;
    let val = '';
    for (let i = 0; i < str.length; i++) {
        let char = str[i];
        if (char === '"') {
            if (inQuotes && str[i+1] === '"') { val += '"'; i++; } 
            else { inQuotes = !inQuotes; }
        } else if ((char === ';' || char === ',') && !inQuotes) {
            row.push(val.trim()); val = '';
        } else if (char === '\n' && !inQuotes) {
            row.push(val.trim()); result.push(row); row = []; val = '';
        } else {
            if (char !== '\r') val += char;
        }
    }
    row.push(val.trim());
    result.push(row);
    return result;
};

export default function Products({ isAdmin, userId }: { isAdmin: boolean, userId: string }) {
    const [products, setProducts] = useState<any[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [successModal, setSuccessModal] = useState({ show: false, title: '', text: '' });
    const [errorModal, setErrorModal] = useState({ show: false, text: '' });
    
    // Состояние для активной категории
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    
    // Модалки
    const [showProductForm, setShowProductForm] = useState(false);
    const [productFormData, setProductFormData] = useState({
        id: '', name: '', category: '', price: '', desc: '', isHit: false, isHidden: false, dateAdded: ''
    });
    const [confirmDelete, setConfirmDelete] = useState<{isOpen: boolean, id: string, name: string}>({ isOpen: false, id: '', name: '' });
    const [viewProduct, setViewProduct] = useState<any>(null);

    // Загрузка данных
    useEffect(() => {
        const loadProducts = async () => {
            try {
                const res = await fetch(`/api/storage?key=${STORAGE_KEYS.PRODUCTS}`, { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) {
                        setProducts(data);
                    }
                }
            } catch (e) {
                console.error("Ошибка загрузки продуктов", e);
            }
        };
        loadProducts();
    }, []);

    const handleSaveProduct = () => {
        if (!productFormData.name.trim()) { alert("Введите название продукта!"); return; }
        
        const newProduct = {
            ...productFormData,
            id: productFormData.id || 'prod_' + Date.now(),
            dateAdded: productFormData.id && productFormData.dateAdded ? productFormData.dateAdded : new Date().toLocaleDateString('ru-RU')
        };

        let updatedProducts = [...products];
        if (productFormData.id) {
            updatedProducts = updatedProducts.map(p => p.id === productFormData.id ? newProduct : p);
        } else {
            updatedProducts.unshift(newProduct);
        }

        setProducts(updatedProducts);
        saveDataToServer(STORAGE_KEYS.PRODUCTS, updatedProducts);
        setShowProductForm(false);
    };

    const executeDelete = () => {
        const updatedProducts = products.filter(p => p.id !== confirmDelete.id);
        setProducts(updatedProducts);
        saveDataToServer(STORAGE_KEYS.PRODUCTS, updatedProducts);
        setConfirmDelete({ isOpen: false, id: '', name: '' });
    };

    // ТУМБЛЕРЫ ХИТОВ И СКРЫТИЯ
    const toggleHit = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        const updated = products.map(p => p.id === id ? { ...p, isHit: !p.isHit } : p);
        setProducts(updated);
        saveDataToServer(STORAGE_KEYS.PRODUCTS, updated);
    };

    const toggleHidden = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        const updated = products.map(p => p.id === id ? { ...p, isHidden: !p.isHidden } : p);
        setProducts(updated);
        saveDataToServer(STORAGE_KEYS.PRODUCTS, updated);
    };

    // ЭКСПОРТ АКТУАЛЬНЫХ ТОВАРОВ В CSV (ДЛЯ РЕДАКТИРОВАНИЯ В EXCEL)
    const exportToCSV = () => {
        const bom = "\uFEFF"; 
        const header = "Название;Категория;Цена;Описание\n";
        let csvContent = header;

        if (products.length > 0) {
            products.forEach(p => {
                const safeName = `"${(p.name || '').toString().replace(/"/g, '""')}"`;
                const safeCat = `"${(p.category || '').toString().replace(/"/g, '""')}"`;
                const safePrice = `"${(p.price || '').toString().replace(/"/g, '""')}"`;
                const safeDesc = `"${(p.desc || '').toString().replace(/"/g, '""')}"`;
                csvContent += `${safeName};${safeCat};${safePrice};${safeDesc}\n`;
            });
        } else {
            csvContent += `"Те Гуань Инь Ван";"Светлые улуны";"1500";"Премиальный улун с цветочным ароматом."\n`;
        }

        const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `products_export_${new Date().toLocaleDateString('ru-RU').replace(/\./g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // УМНЫЙ ИМПОРТ ТОВАРОВ ИЗ EXCEL
    const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const text = evt.target?.result as string;
            const rows = parseCSV(text).filter(r => r.length > 1 && r[0].trim() !== '');
            
            if (rows.length <= 1) {
                setErrorModal({ show: true, text: 'Файл пуст или содержит только заголовки.' });
                return;
            }

            const newProds: any[] = [];
            let currentProds = [...products];
            let updatedCount = 0;
            let addedCount = 0;

            for (let i = 1; i < rows.length; i++) {
                const cols = rows[i];
                const name = cols[0] ? cols[0].trim() : '';
                if (!name) continue;

                const category = cols[1] ? cols[1].trim() : '';
                const price = cols[2] ? cols[2].trim() : '';
                const desc = cols[3] ? cols[3].trim() : '';

                const existingIdx = currentProds.findIndex(p => p.name.toLowerCase() === name.toLowerCase());

                if (existingIdx !== -1) {
                    currentProds[existingIdx] = {
                        ...currentProds[existingIdx],
                        category: category !== '' ? category : currentProds[existingIdx].category,
                        price: price !== '' ? price : currentProds[existingIdx].price,
                        desc: desc !== '' ? desc : currentProds[existingIdx].desc
                    };
                    updatedCount++;
                } else {
                    newProds.push({
                        id: 'prod_' + Date.now() + '_' + i,
                        name: name,
                        category: category,
                        price: price,
                        desc: desc,
                        isHit: false,
                        isHidden: false,
                        dateAdded: new Date().toLocaleDateString('ru-RU')
                    });
                    addedCount++;
                }
            }

            const finalProducts = [...newProds, ...currentProds];
            setProducts(finalProducts);
            saveDataToServer(STORAGE_KEYS.PRODUCTS, finalProducts);
            
            setSuccessModal({
                show: true,
                title: 'Импорт завершён',
                text: `Добавлено новых товаров: ${addedCount}. Обновлено существующих: ${updatedCount}.`
            });
        };
        reader.readAsText(file, "UTF-8");
        e.target.value = '';
    };

    // ФИЛЬТРАЦИЯ
    const baseFiltered = products.filter(p => isAdmin || !p.isHidden);
    
    const categories = Array.from(new Set(baseFiltered.map(p => p.category).filter(Boolean)));

    const searchedProducts = baseFiltered.filter(p => 
        (p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
        (p.category && p.category.toLowerCase().includes(searchQuery.toLowerCase()))) &&
        (!selectedCategory || p.category === selectedCategory)
    );

    // ИСПРАВЛЕНИЕ: Блок "Обязательно к продаже" теперь ГЛОБАЛЬНЫЙ. Убрана фильтрация по selectedCategory
    const hitProducts = baseFiltered.filter(p => 
        p.isHit && 
        (!searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()) || (p.category && p.category.toLowerCase().includes(searchQuery.toLowerCase())))
    );

    return (
        <section className="lms-products-page" style={{ animation: 'fadeInUp 0.6s ease', maxWidth: '100%' }}>
            
            {/* ШАПКА И КНОПКИ АДМИНА */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
                <h2 style={{ fontSize: '32px', fontWeight: '900', margin: 0, color: '#fff' }}>Товары и Продукты</h2>
                {isAdmin && (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <button onClick={exportToCSV} style={{...adminActionBtn, background: 'rgba(255,255,255,0.05)', color: '#aaa', border: '1px solid #333', display: 'inline-flex', alignItems: 'center', gap: '8px'} as any}><CustomIcon name="download" size={16} color="#aaa" /> ЭКСПОРТ CSV</button>
                        <input type="file" accept=".csv" id="csv-upload" style={{display: 'none'}} onChange={handleImportCSV} />
                        <button onClick={() => document.getElementById('csv-upload')?.click()} style={{...adminActionBtn, background: 'rgba(255,255,255,0.05)', color: '#aaa', border: '1px solid #333', display: 'inline-flex', alignItems: 'center', gap: '8px'} as any}><CustomIcon name="upload" size={16} color="#aaa" /> ИМПОРТ ИЗ ФАЙЛА</button>
                        <button onClick={() => {
                            setProductFormData({ id: '', name: '', category: '', price: '', desc: '', isHit: false, isHidden: false, dateAdded: '' });
                            setShowProductForm(true);
                        }} style={{...adminActionBtn, background: '#0abab5', color: '#000'} as any}>+ НОВЫЙ ТОВАР</button>
                    </div>
                )}
            </div>

            {/* ПОИСК */}
            <div style={{ position: 'relative', marginBottom: '25px' }}>
                <span style={{ position: 'absolute', left: '16px', top: '15px', opacity: 0.5, fontSize: '14px', display: 'flex', alignItems: 'center' }}>
                    <SearchIcon />
                </span>
                <input 
                    type="text" 
                    placeholder="Поиск по названию..." 
                    value={searchQuery} 
                    onChange={(e) => setSearchQuery(e.target.value)} 
                    style={{ ...adminIn, paddingLeft: '45px', background: '#111', border: '1px solid #222' } as any} 
                />
            </div>

            {/* ПАНЕЛЬ КАТЕГОРИЙ */}
            {categories.length > 0 && (
                <div className="custom-scroll" style={{ display: 'flex', gap: '10px', overflowX: 'auto', marginBottom: '35px', paddingBottom: '10px' }}>
                    <div 
                        className={`product-category-filter ${selectedCategory === null ? 'active' : ''}`}
                        onClick={() => setSelectedCategory(null)}
                        style={{
                            padding: '10px 20px', borderRadius: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
                            background: selectedCategory === null ? '#0abab5' : '#1a1a1a',
                            color: selectedCategory === null ? '#000' : '#888',
                            fontWeight: '900', fontSize: '13px', transition: '0.2s',
                            border: `1px solid ${selectedCategory === null ? '#0abab5' : '#333'}`
                        }}
                    >
                        Все категории
                    </div>
                    {categories.map(cat => (
                        <div 
                            key={cat as string}
                            className={`product-category-filter ${selectedCategory === cat ? 'active' : ''}`}
                            onClick={() => setSelectedCategory(cat as string)}
                            style={{
                                padding: '10px 20px', borderRadius: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
                                background: selectedCategory === cat ? '#0abab5' : '#1a1a1a',
                                color: selectedCategory === cat ? '#000' : '#888',
                                fontWeight: '900', fontSize: '13px', transition: '0.2s',
                                border: `1px solid ${selectedCategory === cat ? '#0abab5' : '#333'}`
                            }}
                        >
                            {cat as string}
                        </div>
                    ))}
                </div>
            )}

            {/*  БЛОК: ОБЯЗАТЕЛЬНО К ПРОДАЖЕ */}
            {hitProducts.length > 0 && (
                <div className="required-products-block" style={{ 
                    background: 'linear-gradient(135deg, rgba(255,215,0,0.05) 0%, rgba(0,0,0,0) 100%)', 
                    border: '1px solid rgba(255,215,0,0.2)', 
                    borderRadius: '25px', 
                    padding: '30px', 
                    marginBottom: '40px',
                    boxShadow: '0 10px 30px rgba(255,215,0,0.03)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '25px' }}>
                        <CustomIcon name="flame" size={30} color="#ffd700" />
                        <h3 style={{ fontSize: '20px', color: '#ffd700', fontWeight: '900', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Обязательно к продаже</h3>
                    </div>
                    
                    <div className="hits-scroll-container custom-scroll" style={{ display: 'flex', overflowX: 'auto', gap: '20px', padding: '10px 5px 20px 5px', margin: '-10px -5px 0 -5px', scrollSnapType: 'x mandatory' }}>
                        {hitProducts.map(product => {
                            const isSingle = hitProducts.length === 1;
                            return (
                                <div key={`hit-${product.id}`} className={`premium-card hit-card ${isSingle ? 'single-hit' : ''}`} onClick={() => setViewProduct(product)} style={{ 
                                    minWidth: isSingle ? '100%' : '280px', flex: isSingle ? '1 1 auto' : '0 0 auto', padding: '25px', scrollSnapAlign: 'start', 
                                    opacity: product.isHidden ? 0.4 : 1, filter: product.isHidden ? 'grayscale(100%)' : 'none',
                                    background: '#111', border: '1px solid rgba(255,215,0,0.4)', display: 'flex', flexDirection: isSingle ? 'row' : 'column',
                                    alignItems: isSingle ? 'center' : 'stretch', justifyContent: isSingle ? 'space-between' : 'flex-start'
                                }}>
                                    {isAdmin && (
                                        <div style={{ position: 'absolute', top: '15px', right: '15px', display: 'flex', gap: '5px', zIndex: 10 }}>
                                            <div onClick={(e) => toggleHit(e, product.id)} className="admin-action-icon" style={{...textIconStyle, background: 'rgba(0,0,0,0.8)', color: '#ffd700', border: '1px solid #ffd700'} as any} title="Убрать из обязательных"><CustomIcon name="flame" size={16} color="#ffd700" /></div>
                                            <div onClick={(e) => toggleHidden(e, product.id)} className="admin-action-icon" style={{...textIconStyle, background: 'rgba(0,0,0,0.8)', color: product.isHidden ? '#ff4d4d' : '#0abab5'} as any} title={product.isHidden ? "Показать сотрудникам" : "Скрыть от сотрудников"}><CustomIcon name={product.isHidden ? 'hidden' : 'eye'} size={16} color={product.isHidden ? '#ff4d4d' : '#0abab5'} /></div>
                                        </div>
                                    )}
                                    
                                    <div style={{ flex: isSingle ? '1 1 auto' : 'none' }}>
                                        {product.category && <span style={{ background: 'rgba(255,215,0,0.1)', color: '#ffd700', padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 'bold', width: 'fit-content', marginBottom: '15px', display: 'inline-block' }}>{product.category}</span>}
                                        <h4 style={{ fontSize: '18px', margin: isSingle ? '0' : '0 0 20px 0', fontWeight: 'bold', color: '#fff', lineHeight: '1.3', paddingRight: isAdmin && !isSingle ? '80px' : '0' }}>{product.name}</h4>
                                    </div>
                                    
                                    <div className={isSingle ? "single-hit-stats" : ""} style={{ 
                                        marginTop: isSingle ? '0' : 'auto', 
                                        display: 'flex', 
                                        justifyContent: 'flex-end', 
                                        alignItems: 'flex-end', 
                                        minWidth: isSingle ? '200px' : 'auto',
                                        paddingRight: isAdmin && isSingle ? '100px' : '0'
                                    }}>
                                        <div style={{ textAlign: 'right', width: '100%' }}>
                                            <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>Цена:</div>
                                            <div style={{ color: '#ffd700', fontWeight: '900', fontSize: '22px' }}>{product.price ? `${product.price} ₽` : '—'}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* --- ОСНОВНОЙ КАТАЛОГ --- */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '25px' }}>
                <h3 style={{ fontSize: '20px', color: '#fff', fontWeight: '900', margin: 0, textTransform: 'uppercase' }}>
                    {selectedCategory ? `КАТАЛОГ: ${selectedCategory}` : 'ВЕСЬ КАТАЛОГ'}
                </h3>
                <div style={{ height: '1px', background: '#222', flex: 1 }}></div>
            </div>

            <div className="premium-cards-container">
                {searchedProducts.length === 0 ? (
                    <div style={{ color: '#555', fontSize: '14px', background: '#111', padding: '30px', borderRadius: '30px', border: '1px dashed #222', textAlign: 'center', gridColumn: '1 / -1' }}>
                        Товары не найдены
                    </div>
                ) : (
                    searchedProducts.map((product) => (
                        <div key={product.id} className="premium-card" onClick={() => setViewProduct(product)} style={{ padding: '25px', opacity: product.isHidden ? 0.4 : 1, filter: product.isHidden ? 'grayscale(100%)' : 'none', display: 'flex', flexDirection: 'column' }}>
                            
                            {isAdmin && (
                                <div style={{ position: 'absolute', top: '15px', right: '15px', display: 'flex', gap: '5px', zIndex: 10 }}>
                                    <div onClick={(e) => toggleHit(e, product.id)} className="admin-action-icon" style={{...textIconStyle, color: product.isHit ? '#ffd700' : '#666'} as any} title="В обязательные"><CustomIcon name={product.isHit ? 'flame' : 'star'} size={16} color={product.isHit ? '#ffd700' : '#666'} /></div>
                                    <div onClick={(e) => toggleHidden(e, product.id)} className="admin-action-icon" style={{...textIconStyle, color: product.isHidden ? '#ff4d4d' : '#0abab5'} as any} title="Скрыть/Показать"><CustomIcon name={product.isHidden ? 'hidden' : 'eye'} size={16} color={product.isHidden ? '#ff4d4d' : '#0abab5'} /></div>
                                    <div onClick={(e) => { e.stopPropagation(); setProductFormData(product); setShowProductForm(true); }} className="admin-action-icon" style={textIconStyle as any} title="Редактировать"><CustomIcon name="edit" size={16} color="#0abab5" /></div>
                                    <div onClick={(e) => { e.stopPropagation(); setConfirmDelete({isOpen: true, id: product.id, name: product.name}); }} className="admin-action-icon" style={delIconStyle as any} title="Удалить"><CustomIcon name="close" size={16} color="#ff4d4d" /></div>
                                </div>
                            )}
                            
                            {isAdmin && product.isHidden && (
                                <div style={{ position: 'absolute', top: '60px', right: '15px', background: '#ff4d4d', color: '#fff', padding: '4px 10px', borderRadius: '8px', fontWeight: 'bold', fontSize: '10px', zIndex: 5 }}>
                                    СКРЫТО
                                </div>
                            )}

                            <div style={{ paddingRight: isAdmin ? '130px' : '0', marginBottom: '20px', marginTop: (isAdmin && product.isHidden) ? '25px' : '0' }}>
                                {product.category && <span style={{ background: 'rgba(10,186,181,0.1)', color: '#0abab5', padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 'bold', display: 'inline-block', marginBottom: '10px' }}>{product.category}</span>}
                                <h4 style={{ fontSize: '18px', margin: 0, fontWeight: 'bold', wordBreak: 'break-word', color: '#fff', lineHeight: '1.3' }}>{product.name}</h4>
                            </div>
                            
                            <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', paddingTop: '15px', borderTop: '1px solid #222' }}>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>Цена:</div>
                                    <div style={{ fontSize: '20px', color: '#0abab5', fontWeight: '900' }}>{product.price ? `${product.price} ₽` : '—'}</div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* --- РЕДАКТОР ПРОДУКТА --- */}
            {showProductForm && (
                <div style={modalOverlay as any} onClick={() => setShowProductForm(false)}>
                    <div className="tasks-modal custom-scroll" style={{...modalContentMedium, margin: '0 auto', maxHeight: '90vh', overflowY: 'auto'} as any} onClick={e => e.stopPropagation()}>
                        <h2 style={{ textAlign: 'center', marginBottom: '25px', color: '#0abab5', fontWeight: '900', textTransform: 'uppercase' }}>
                            {productFormData.id ? 'РЕДАКТИРОВАТЬ ТОВАР' : 'НОВЫЙ ТОВАР'}
                        </h2>
                        
                        <div style={{display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '25px'}}>
                            <div>
                                <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '5px', marginLeft: '5px' }}>Название товара *</div>
                                <input style={adminIn as any} placeholder="Например: Те Гуань Инь Ван" value={productFormData.name} onChange={e => setProductFormData({...productFormData, name: e.target.value})} />
                            </div>
                            
                            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px'}}>
                                <div>
                                    <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '5px', marginLeft: '5px' }}>Цена (₽)</div>
                                    <input type="text" style={adminIn as any} placeholder="0" value={productFormData.price} onChange={e => setProductFormData({...productFormData, price: e.target.value})} />
                                </div>
                                <div>
                                    <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '5px', marginLeft: '5px' }}>Категория</div>
                                    <input list="prod-categories" style={adminIn as any} placeholder="Напр. Светлые улуны" value={productFormData.category} onChange={e => setProductFormData({...productFormData, category: e.target.value})} />
                                    <datalist id="prod-categories">{categories.map((c: any) => <option key={c} value={c} />)}</datalist>
                                </div>
                            </div>

                            <div>
                                <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '5px', marginLeft: '5px' }}>Описание</div>
                                <textarea style={{...adminIn, height: '120px', resize: 'none'} as any} placeholder="Описание, вкус, особенности..." value={productFormData.desc} onChange={e => setProductFormData({...productFormData, desc: e.target.value})} />
                            </div>
                        </div>

                        <button onClick={handleSaveProduct} style={saveBtn as any}>СОХРАНИТЬ ТОВАР</button>
                        <div onClick={() => setShowProductForm(false)} style={cancelLink as any}>ОТМЕНА</div>
                    </div>
                </div>
            )}

            {/* --- ОКНО ПРОСМОТРА ПРОДУКТА --- */}
            {viewProduct && !showProductForm && (
                <div style={modalOverlay as any} onClick={() => setViewProduct(null)}>
                    <div className="tasks-modal custom-scroll" style={{...modalContentLarge, maxWidth: '700px', maxHeight: '90vh', overflowY: 'auto', padding: '40px', position: 'relative'} as any} onClick={e => e.stopPropagation()}>
                        
                        <div onClick={() => setViewProduct(null)} style={{ position: 'absolute', top: '25px', right: '25px', cursor: 'pointer', color: '#ff4d4d', lineHeight: 1, zIndex: 10, display: 'inline-flex' }}><CustomIcon name="close" size={24} color="#ff4d4d" /></div>
                        
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '20px', marginBottom: '30px', paddingRight: '40px' }}>
                            <div>
                                {viewProduct.category && <span style={{fontSize:'12px', color:'#0abab5', fontWeight:'900', letterSpacing:'1px', textTransform:'uppercase', background: 'rgba(10,186,181,0.1)', padding: '5px 12px', borderRadius: '8px', display: 'inline-block', marginBottom: '15px'}}>{viewProduct.category}</span>}
                                <h2 style={{fontSize:'32px', color:'#fff', fontWeight:'900', margin:'0'}}>{viewProduct.name}</h2>
                                {viewProduct.isHit && <div style={{ color: '#ffd700', fontWeight: 'bold', fontSize: '13px', marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}><CustomIcon name="flame" size={16} color="#ffd700" /> ОБЯЗАТЕЛЬНО К ПРОДАЖЕ</div>}
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '40px', marginBottom: '35px', background: '#111', padding: '20px 30px', borderRadius: '20px', border: '1px solid #222' }}>
                            <div>
                                <div style={{ fontSize: '13px', color: '#888', marginBottom: '4px' }}>Цена:</div>
                                <div style={{ fontSize: '28px', color: '#0abab5', fontWeight: '900', lineHeight: 1 }}>{viewProduct.price ? `${viewProduct.price} ₽` : '—'}</div>
                            </div>
                        </div>

                        {viewProduct.desc && (
                            <div>
                                <h4 style={{ fontSize: '14px', color: '#888', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '15px' }}>Описание</h4>
                                <p style={{ fontSize: '15px', color: '#ccc', lineHeight: '1.6', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{viewProduct.desc}</p>
                            </div>
                        )}
                        
                    </div>
                </div>
            )}

            {/* --- ОКНО УДАЛЕНИЯ --- */}
            {confirmDelete.isOpen && (
                <div style={modalOverlay as any} onClick={() => setConfirmDelete({isOpen: false, id: '', name: ''})}>
                    <div style={{...modalContentSmall, textAlign: 'center'} as any} onClick={e => e.stopPropagation()}>
                        <div style={{ width: '60px', height: '60px', borderRadius: '18px', border: '1px solid rgba(255,77,77,0.35)', background: 'rgba(255,77,77,0.08)', color: '#ff4d4d', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px auto' }}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                        <h2 style={{ color: '#ff4d4d', fontWeight: '900', marginBottom: '15px' }}>УДАЛИТЬ ТОВАР?</h2>
                        <p style={{ color: '#ccc', fontSize: '14px', marginBottom: '25px' }}>Вы уверены, что хотите безвозвратно удалить "{confirmDelete.name}"?</p>
                        <div style={{ display: 'flex', gap: '15px' }}>
                            <button onClick={() => setConfirmDelete({isOpen: false, id: '', name: ''})} style={{ ...saveBtn, background: '#222', color: '#fff', flex: 1, marginTop: 0 } as any}>ОТМЕНА</button>
                            <button onClick={executeDelete} style={{ ...saveBtn, background: '#ff4d4d', color: '#fff', flex: 1, marginTop: 0 } as any}>УДАЛИТЬ</button>
                        </div>
                    </div>
                </div>
            )}

            {successModal.show && (
                <div style={modalOverlay as any} onClick={() => setSuccessModal({ show: false, title: '', text: '' })}>
                    <div style={{ ...modalContentSmall, textAlign: 'center' } as any} onClick={e => e.stopPropagation()}>
                        <div style={{ marginBottom: '20px', animation: 'scaleIn 0.3s ease' }}>
                            <svg width="60" height="60" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" fill="rgba(10,186,181,0.1)" stroke="#0abab5" strokeWidth="2"/>
                                <path d="M8 12L11 15L16 9" stroke="#0abab5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </div>
                        <h2 style={{ color: '#0abab5', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>{successModal.title}</h2>
                        <p style={{ color: '#ccc', fontSize: '15px', lineHeight: '1.5', marginBottom: '25px' }}>{successModal.text}</p>
                        <button onClick={() => setSuccessModal({ show: false, title: '', text: '' })} style={saveBtn as any}>ПОНЯТНО</button>
                    </div>
                </div>
            )}

            {errorModal.show && (
                <div style={modalOverlay as any} onClick={() => setErrorModal({ show: false, text: '' })}>
                    <div style={{ ...modalContentSmall, textAlign: 'center' } as any} onClick={e => e.stopPropagation()}>
                        <div style={{ marginBottom: '20px' }}>
                            <svg width="60" height="60" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" fill="rgba(255,77,77,0.1)" stroke="#ff4d4d" strokeWidth="2"/>
                                <path d="M15 9L9 15M9 9L15 15" stroke="#ff4d4d" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                        </div>
                        <h2 style={{ color: '#ff4d4d', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>Ошибка</h2>
                        <p style={{ color: '#ccc', fontSize: '15px', lineHeight: '1.5', marginBottom: '25px' }}>{errorModal.text}</p>
                        <button onClick={() => setErrorModal({ show: false, text: '' })} style={{ ...saveBtn, background: '#ff4d4d', color: '#fff' } as any}>ПОНЯТНО</button>
                    </div>
                </div>
            )}

            <style jsx global>{`
                .premium-cards-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; width: 100%; }
                .premium-card { background: #111; border-radius: 20px; border: 1px solid #222; transition: all 0.2s ease; position: relative; cursor: pointer; box-sizing: border-box; }
                .premium-card:hover { border-color: #0abab5; transform: translateY(-3px); }
                .premium-card:active { transform: scale(0.98); }
                
                .hits-scroll-container::-webkit-scrollbar { height: 6px; }
                .hits-scroll-container::-webkit-scrollbar-thumb { background: #444; border-radius: 10px; }
                
                .hit-card:hover { border-color: #ffd700 !important; box-shadow: 0 5px 20px rgba(255,215,0,0.15); transform: translateY(-3px); }

                /* СТИЛЬ ДЛЯ ИКОНОК АДМИНА С БИРЮЗОВОЙ И ЗОЛОТОЙ ОБВОДКОЙ */
                .admin-action-icon {
                    transition: all 0.2s ease;
                }
                
                /* По умолчанию обводка бирюзовая */
                .admin-action-icon:hover {
                    box-shadow: 0 0 0 1.5px #0abab5 !important;
                    border-color: #0abab5 !important;
                    transform: scale(1.1);
                    z-index: 20;
                }

                /* Для иконок внутри хитов обводка золотая */
                .hit-card .admin-action-icon:hover {
                    box-shadow: 0 0 0 1.5px #ffd700 !important;
                    border-color: #ffd700 !important;
                }

                /* СТИЛЬ ДЛЯ ОДИНОЧНОГО ХИТА (РАСТЯГИВАНИЕ) */
                .single-hit {
                    flex-direction: row !important;
                    align-items: center;
                    justify-content: space-between;
                    padding: 30px 40px !important;
                }

                @media (max-width: 768px) {
                    .premium-cards-container { display: grid !important; grid-template-columns: 1fr !important; gap: 15px !important; }
                    .tasks-modal { padding: 30px 20px !important; border-radius: 25px !important; width: 95% !important; max-height: 90vh !important; }
                    .hit-card { min-width: 240px !important; }
                    
                    .single-hit {
                        flex-direction: column !important;
                        align-items: flex-start !important;
                        padding: 25px !important;
                    }
                    .single-hit h4 {
                        margin-bottom: 20px !important;
                    }
                    .single-hit-stats {
                        width: 100%;
                        justify-content: flex-end !important;
                        padding-right: 0 !important;
                    }
                }
            `}</style>
        </section>
    );
}

function SearchIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.5 18C14.6421 18 18 14.6421 18 10.5C18 6.35786 14.6421 3 10.5 3C6.35786 3 3 6.35786 3 10.5C3 14.6421 6.35786 18 10.5 18Z" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

// --- СТИЛИ ---
const adminActionBtn = { background: 'rgba(10,186,181,0.1)', color: '#0abab5', border: '1px solid rgba(10,186,181,0.3)', padding: '10px 20px', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '13px', letterSpacing: '1px', transition: '0.2s' };
const adminIn = { width: '100%', padding: '16px', background: '#000', border: '1px solid #333', borderRadius: '15px', color: '#fff', marginBottom: '0', outline: 'none', fontSize: '15px', boxSizing: 'border-box' };
const saveBtn = { width: '100%', padding: '18px', background: '#0abab5', color: '#000', border: 'none', borderRadius: '15px', fontWeight: '900', cursor: 'pointer', marginTop: '25px', fontSize: '15px', letterSpacing: '1px' };
const cancelLink = { textAlign: 'center', marginTop: '20px', color: '#666', cursor: 'pointer', fontWeight: 'bold', fontSize: '14px' };
const editIconStyle = { background: '#1a1a1a', border: '1px solid #333', width: '36px', height: '36px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '16px', flexShrink: 0, fontWeight: 'bold' };
const textIconStyle = { ...editIconStyle, minWidth: '36px', width: 'auto', padding: '0 8px', fontSize: '10px', letterSpacing: '0.5px' };
const hitBadgeStyle = { background: 'rgba(255,215,0,0.1)', color: '#ffd700', border: '1px solid rgba(255,215,0,0.35)', borderRadius: '10px', padding: '6px 10px', fontSize: '11px', fontWeight: '900', letterSpacing: '1px' };
const delIconStyle = { background: '#1a1a1a', color: '#ff4d4d', border: '1px solid #333', width: '36px', height: '36px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '16px', flexShrink: 0, fontWeight: 'bold' };
const modalOverlay = { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.92)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)', padding: '20px', boxSizing: 'border-box' };
const modalContentLarge = { background: '#000', borderRadius: '40px', maxWidth: '1100px', width: '100%', border: '1px solid #222', maxHeight: '90vh', overflowY: 'auto' };
const modalContentMedium = { background: '#111', padding: '40px 30px', borderRadius: '35px', width: '100%', maxWidth: '550px', border: '1px solid #333', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' };
const modalContentSmall = { background: '#111', padding: '40px 30px', borderRadius: '30px', width: '100%', maxWidth: '400px', border: '1px solid #333', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' };
